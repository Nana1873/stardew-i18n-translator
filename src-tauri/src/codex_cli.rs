//! Direct Codex CLI adapter.
//!
//! The app asks the installed CLI for version/login status and uses
//! `codex exec` for bounded structured translation chunks. It never reads the
//! CLI's auth/config files or receives an auth token.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::ai::{self, PreparedAiItem, ProviderFailure, ProviderTranslation};

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const TRANSLATION_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_DIAGNOSTIC_OUTPUT_BYTES: u64 = 128 * 1024;
const MAX_FINAL_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy)]
struct OutputLimits {
    stdout: u64,
    stderr: u64,
}

const STATUS_OUTPUT_LIMITS: OutputLimits = OutputLimits {
    stdout: MAX_DIAGNOSTIC_OUTPUT_BYTES,
    stderr: MAX_DIAGNOSTIC_OUTPUT_BYTES,
};
const TRANSLATION_OUTPUT_LIMITS: OutputLimits = OutputLimits {
    stdout: MAX_FINAL_OUTPUT_BYTES,
    stderr: MAX_DIAGNOSTIC_OUTPUT_BYTES,
};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authentication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct TempRunDir {
    path: PathBuf,
}

impl TempRunDir {
    fn create(tag: &str) -> Result<Self, String> {
        let base = std::env::temp_dir();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for attempt in 0..20u8 {
            let path = base.join(format!(
                "stardew-i18n-translator-{tag}-{}-{timestamp}-{attempt}",
                std::process::id()
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not create a temporary Codex folder: {error}"
                    ));
                }
            }
        }
        Err("Could not create a unique temporary Codex folder.".to_string())
    }
}

impl Drop for TempRunDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

enum ProcessResult {
    Finished {
        success: bool,
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    Cancelled,
    TimedOut,
    OutputLimitExceeded,
}

fn run_command(
    executable: &Path,
    args: &[OsString],
    stdin_body: Option<&str>,
    working_dir: &Path,
    timeout: Duration,
    cancelled: &AtomicBool,
    output_limits: OutputLimits,
) -> Result<ProcessResult, String> {
    #[cfg(windows)]
    {
        windows_process::run(
            executable,
            args,
            stdin_body,
            working_dir,
            timeout,
            cancelled,
            output_limits,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (
            executable,
            args,
            stdin_body,
            working_dir,
            timeout,
            cancelled,
            output_limits,
        );
        Err("Codex CLI integration is available only on Windows.".to_string())
    }
}

#[cfg(windows)]
mod windows_process {
    use std::ffi::{c_void, OsStr, OsString};
    use std::fs::File;
    use std::io::{Read, Write};
    use std::mem::{size_of, size_of_val};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle, RawHandle};
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver},
        Arc,
    };
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    use super::{OutputLimits, ProcessResult};

    const POLL_INTERVAL: Duration = Duration::from_millis(10);
    const IO_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
    const TERMINATION_WAIT_MILLIS: u32 = 5_000;

    fn owned_handle(handle: HANDLE) -> OwnedHandle {
        // SAFETY: callers pass a fresh, non-null Win32 handle and transfer its
        // sole ownership to the returned OwnedHandle.
        unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }
    }

    fn raw_handle(handle: &OwnedHandle) -> HANDLE {
        handle.as_raw_handle() as HANDLE
    }

    fn handle_file(handle: OwnedHandle) -> File {
        // SAFETY: ownership moves out of OwnedHandle and into File exactly
        // once, so the underlying kernel handle still has one owner.
        unsafe { File::from_raw_handle(handle.into_raw_handle()) }
    }

    struct Job(OwnedHandle);

    impl Job {
        fn create() -> Result<Self, String> {
            // SAFETY: null attributes/name create an unnamed job. The returned
            // handle is immediately placed under OwnedHandle ownership.
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err("Could not create a safe Codex process group.".to_string());
            }
            let job = Self(owned_handle(handle));
            // SAFETY: `information` has the exact structure/size requested by
            // JobObjectExtendedLimitInformation and lives for the call.
            let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&information).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err("Could not configure the safe Codex process group.".to_string());
            }
            Ok(job)
        }

        fn raw(&self) -> HANDLE {
            raw_handle(&self.0)
        }

        fn terminate(&self) {
            // SAFETY: this is our live job handle. Terminating a job is
            // idempotent for cleanup purposes; failure is handled by the
            // KILL_ON_JOB_CLOSE fallback when the handle drops.
            unsafe {
                TerminateJobObject(self.raw(), 1);
            }
        }
    }

    struct AttributeList {
        _storage: Vec<usize>,
        pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl AttributeList {
        fn create(attribute_count: u32) -> Result<Self, String> {
            let mut bytes = 0usize;
            // SAFETY: the documented first call uses a null buffer only to
            // obtain the required allocation size.
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err("Could not size secure Codex process attributes.".to_string());
            }
            let words = bytes.div_ceil(size_of::<usize>());
            let mut storage = vec![0usize; words];
            let pointer = storage.as_mut_ptr().cast::<c_void>();
            // SAFETY: Vec<usize> provides pointer alignment and at least the
            // byte size returned by the sizing call; the Vec stays alive.
            let initialized = unsafe {
                InitializeProcThreadAttributeList(pointer, attribute_count, 0, &mut bytes)
            };
            if initialized == 0 {
                return Err("Could not initialize secure Codex process attributes.".to_string());
            }
            Ok(Self {
                _storage: storage,
                pointer,
            })
        }

        fn set_handles(&mut self, attribute: u32, handles: &[HANDLE]) -> Result<(), String> {
            // SAFETY: both the attribute list and handle slice remain alive
            // through CreateProcessW. The API copies their values into the
            // initialized attribute list.
            let updated = unsafe {
                UpdateProcThreadAttribute(
                    self.pointer,
                    0,
                    attribute as usize,
                    handles.as_ptr().cast(),
                    size_of_val(handles),
                    null_mut(),
                    null(),
                )
            };
            if updated == 0 {
                return Err("Could not configure secure Codex process attributes.".to_string());
            }
            Ok(())
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            // SAFETY: this pointer was successfully initialized exactly once
            // and remains backed by `_storage` until after this call.
            unsafe { DeleteProcThreadAttributeList(self.pointer) };
        }
    }

    fn anonymous_pipe(parent_reads: bool) -> Result<(OwnedHandle, OwnedHandle), String> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let mut read = null_mut();
        let mut write = null_mut();
        // SAFETY: output pointers are valid and the security-attributes value
        // lives through the call. Successful raw handles are owned below.
        let created = unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) };
        if created == 0 {
            return Err("Could not create secure Codex process pipes.".to_string());
        }
        let read = owned_handle(read);
        let write = owned_handle(write);
        let (parent, child) = if parent_reads {
            (read, write)
        } else {
            (write, read)
        };
        // SAFETY: the parent endpoint is valid. Clearing only the inheritance
        // flag ensures CreateProcessW cannot leak it into the child.
        let protected =
            unsafe { SetHandleInformation(raw_handle(&parent), HANDLE_FLAG_INHERIT, 0) };
        if protected == 0 {
            return Err("Could not protect a Codex process pipe.".to_string());
        }
        Ok((parent, child))
    }

    fn wide_z(value: &OsStr, label: &str) -> Result<Vec<u16>, String> {
        let mut wide = value.encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            return Err(format!(
                "The Codex {label} contains an invalid NUL character."
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    fn push_quoted_argument(command_line: &mut Vec<u16>, value: &OsStr) -> Result<(), String> {
        let value = value.encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err("A Codex CLI argument contains an invalid NUL character.".to_string());
        }
        command_line.push(b'"' as u16);
        let mut backslashes = 0usize;
        for unit in value {
            if unit == b'\\' as u16 {
                backslashes += 1;
            } else if unit == b'"' as u16 {
                command_line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
                command_line.push(unit);
                backslashes = 0;
            } else {
                command_line.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
                command_line.push(unit);
                backslashes = 0;
            }
        }
        command_line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
        command_line.push(b'"' as u16);
        Ok(())
    }

    fn command_line(executable: &Path, args: &[OsString]) -> Result<Vec<u16>, String> {
        let mut command_line = Vec::new();
        push_quoted_argument(&mut command_line, executable.as_os_str())?;
        for argument in args {
            command_line.push(b' ' as u16);
            push_quoted_argument(&mut command_line, argument)?;
        }
        command_line.push(0);
        if command_line.len() > 32_767 {
            return Err("The Codex CLI command line is too long for Windows.".to_string());
        }
        Ok(command_line)
    }

    fn canonical_exe(candidate: &Path) -> Option<PathBuf> {
        let is_exe = candidate
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"));
        if !is_exe || !candidate.is_file() {
            return None;
        }
        candidate.canonicalize().ok()
    }

    fn executable_search_dirs() -> Vec<PathBuf> {
        let mut directories = Vec::new();
        if let Ok(current_executable) = std::env::current_exe() {
            if let Some(directory) = current_executable.parent() {
                directories.push(directory.to_path_buf());
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            directories.extend(
                std::env::split_paths(&path).filter(|directory| !directory.as_os_str().is_empty()),
            );
        }
        directories
    }

    fn npm_native_candidates(shim_directory: &Path) -> Vec<PathBuf> {
        let (target, platform_package) = match std::env::consts::ARCH {
            "x86_64" => ("x86_64-pc-windows-msvc", "codex-win32-x64"),
            "aarch64" => ("aarch64-pc-windows-msvc", "codex-win32-arm64"),
            _ => return Vec::new(),
        };
        let openai_modules = shim_directory.join("node_modules").join("@openai");
        let package_roots = [
            openai_modules
                .join("codex")
                .join("node_modules")
                .join("@openai")
                .join(platform_package),
            openai_modules.join(platform_package),
        ];
        package_roots
            .into_iter()
            .flat_map(|package_root| {
                ["bin", "codex"].into_iter().map(move |directory| {
                    package_root
                        .join("vendor")
                        .join(target)
                        .join(directory)
                        .join("codex.exe")
                })
            })
            .collect()
    }

    pub(super) fn resolve_native_executable(requested: &OsStr) -> Result<PathBuf, String> {
        let requested = Path::new(requested);
        let bare_name = requested.components().count() == 1;
        let extension = requested.extension();
        if extension.is_some_and(|value| !value.eq_ignore_ascii_case("exe")) {
            return Err(
                "Codex CLI command shims are not executed for safety; a native codex.exe is required."
                    .to_string(),
            );
        }

        let executable_name = if extension.is_some() {
            requested.to_path_buf()
        } else {
            requested.with_extension("exe")
        };
        if !bare_name {
            return canonical_exe(&executable_name).ok_or_else(|| {
                "The configured Codex CLI is not a directly executable native .exe file."
                    .to_string()
            });
        }

        let directories = executable_search_dirs();
        for directory in &directories {
            if let Some(executable) = canonical_exe(&directory.join(&executable_name)) {
                return Ok(executable);
            }
        }

        let stem = requested.file_stem().unwrap_or(requested.as_os_str());
        let shim_directories = directories
            .iter()
            .filter(|directory| {
                ["cmd", "bat", "ps1"]
                    .iter()
                    .any(|extension| directory.join(stem).with_extension(extension).is_file())
            })
            .collect::<Vec<_>>();
        // The official npm launcher is a command shim, which we deliberately
        // never execute through a shell. Resolve only the package's fixed,
        // platform-specific native-binary location behind that shim.
        for directory in &shim_directories {
            for candidate in npm_native_candidates(directory) {
                if let Some(executable) = canonical_exe(&candidate) {
                    return Ok(executable);
                }
            }
        }
        let shim_found = !shim_directories.is_empty();
        if shim_found {
            Err(
                "Codex CLI was found only as a command shim, but its packaged native codex.exe is unavailable. Reinstall or update Codex CLI."
                    .to_string(),
            )
        } else {
            Err(
                "Codex CLI was not found. Install it and make its native codex.exe available on PATH."
                    .to_string(),
            )
        }
    }

    struct SuspendedProcess {
        job: Job,
        process: OwnedHandle,
        thread: Option<OwnedHandle>,
    }

    struct ProcessIo {
        stdin: File,
        stdout: File,
        stderr: File,
    }

    impl SuspendedProcess {
        fn spawn(
            executable: &Path,
            args: &[OsString],
            working_dir: &Path,
        ) -> Result<(Self, ProcessIo), String> {
            let executable = canonical_exe(executable).ok_or_else(|| {
                "The Codex CLI executable is unavailable or is not a native .exe file.".to_string()
            })?;
            let job = Job::create()?;
            let (stdin, child_stdin) = anonymous_pipe(false)?;
            let (stdout, child_stdout) = anonymous_pipe(true)?;
            let (stderr, child_stderr) = anonymous_pipe(true)?;

            let mut attributes = AttributeList::create(2)?;
            let inherited_handles = [
                raw_handle(&child_stdin),
                raw_handle(&child_stdout),
                raw_handle(&child_stderr),
            ];
            attributes.set_handles(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited_handles)?;
            let jobs = [job.raw()];
            attributes.set_handles(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;

            let application_name = wide_z(executable.as_os_str(), "executable path")?;
            let current_directory = wide_z(working_dir.as_os_str(), "working folder")?;
            let mut command_line = command_line(&executable, args)?;
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = raw_handle(&child_stdin);
            startup.StartupInfo.hStdOutput = raw_handle(&child_stdout);
            startup.StartupInfo.hStdError = raw_handle(&child_stderr);
            startup.lpAttributeList = attributes.pointer;
            let mut process_information = PROCESS_INFORMATION::default();
            // SAFETY: every pointer refers to live, correctly sized storage.
            // The handle/job allowlists are part of STARTUPINFOEXW, so the
            // suspended process is born in the kill-on-close job and inherits
            // only its three standard-stream handles.
            let created = unsafe {
                CreateProcessW(
                    application_name.as_ptr(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                    null(),
                    current_directory.as_ptr(),
                    std::ptr::from_ref(&startup.StartupInfo),
                    &mut process_information,
                )
            };
            if created == 0 {
                return Err(format!(
                    "Could not start the isolated Codex CLI process: {}",
                    std::io::Error::last_os_error()
                ));
            }

            let process = owned_handle(process_information.hProcess);
            let thread = owned_handle(process_information.hThread);
            drop(child_stdin);
            drop(child_stdout);
            drop(child_stderr);
            Ok((
                Self {
                    job,
                    process,
                    thread: Some(thread),
                },
                ProcessIo {
                    stdin: handle_file(stdin),
                    stdout: handle_file(stdout),
                    stderr: handle_file(stderr),
                },
            ))
        }

        fn resume(&mut self) -> Result<(), String> {
            let thread = self
                .thread
                .take()
                .ok_or_else(|| "The Codex CLI process was already resumed.".to_string())?;
            // SAFETY: this is the primary thread returned for a process created
            // with CREATE_SUSPENDED. u32::MAX is the documented failure value.
            let previous_count = unsafe { ResumeThread(raw_handle(&thread)) };
            if previous_count == u32::MAX {
                self.job.terminate();
                return Err("Could not start the isolated Codex CLI process.".to_string());
            }
            Ok(())
        }

        fn poll(&self) -> Result<Option<u32>, String> {
            // SAFETY: the process handle remains owned by `self`.
            let wait = unsafe { WaitForSingleObject(raw_handle(&self.process), 0) };
            match wait {
                WAIT_OBJECT_0 => {
                    let mut code = 0u32;
                    // SAFETY: the process is signaled and the output pointer is
                    // valid for the duration of the call.
                    if unsafe { GetExitCodeProcess(raw_handle(&self.process), &mut code) } == 0 {
                        Err(format!(
                            "Could not read the Codex CLI exit code: {}",
                            std::io::Error::last_os_error()
                        ))
                    } else {
                        Ok(Some(code))
                    }
                }
                WAIT_TIMEOUT => Ok(None),
                WAIT_FAILED => Err(format!(
                    "Could not monitor Codex CLI: {}",
                    std::io::Error::last_os_error()
                )),
                _ => Err("Could not monitor Codex CLI: unexpected wait result.".to_string()),
            }
        }

        fn terminate_tree_and_wait(&self) {
            self.job.terminate();
            // SAFETY: process termination is asynchronous; this bounded wait
            // lets its handles/pipes settle without ever blocking indefinitely.
            unsafe {
                WaitForSingleObject(raw_handle(&self.process), TERMINATION_WAIT_MILLIS);
            }
        }
    }

    impl Drop for SuspendedProcess {
        fn drop(&mut self) {
            self.job.terminate();
        }
    }

    struct OutputBudget {
        used: AtomicUsize,
        overflowed: AtomicBool,
        limit: usize,
    }

    impl OutputBudget {
        fn new(limit: usize) -> Self {
            Self {
                used: AtomicUsize::new(0),
                overflowed: AtomicBool::new(false),
                limit,
            }
        }

        fn reserve(&self, requested: usize) -> usize {
            loop {
                let used = self.used.load(Ordering::Acquire);
                let available = self.limit.saturating_sub(used);
                let granted = requested.min(available);
                if self
                    .used
                    .compare_exchange_weak(
                        used,
                        used + granted,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
                {
                    if granted < requested {
                        self.overflowed.store(true, Ordering::Release);
                    }
                    return granted;
                }
            }
        }
    }

    fn start_reader(
        name: &'static str,
        mut file: File,
        budget: Arc<OutputBudget>,
        io_failed: Arc<AtomicBool>,
    ) -> Result<Receiver<Result<Vec<u8>, String>>, String> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name(format!("codex-{name}"))
            .spawn(move || {
                let mut captured = Vec::new();
                let mut chunk = [0u8; 8 * 1024];
                let result = loop {
                    match file.read(&mut chunk) {
                        Ok(0) => break Ok(captured),
                        Ok(read) => {
                            let keep = budget.reserve(read);
                            captured.extend_from_slice(&chunk[..keep]);
                            if keep < read {
                                break Ok(captured);
                            }
                        }
                        Err(error) => {
                            io_failed.store(true, Ordering::Release);
                            break Err(format!("Could not read Codex {name}: {error}"));
                        }
                    }
                };
                let _ = sender.send(result);
            })
            .map_err(|error| format!("Could not start the Codex {name} reader: {error}"))?;
        Ok(receiver)
    }

    fn start_writer(
        mut file: File,
        body: Option<&str>,
    ) -> Result<Option<Receiver<Result<(), String>>>, String> {
        let Some(body) = body else {
            drop(file);
            return Ok(None);
        };
        let body = body.as_bytes().to_vec();
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("codex-stdin".to_string())
            .spawn(move || {
                let result = file.write_all(&body).map_err(|error| {
                    format!("Could not send the translation request to Codex: {error}")
                });
                let _ = sender.send(result);
            })
            .map_err(|error| format!("Could not start the Codex input writer: {error}"))?;
        Ok(Some(receiver))
    }

    fn receive_capture(
        receiver: Receiver<Result<Vec<u8>, String>>,
        name: &str,
    ) -> Result<Vec<u8>, String> {
        receiver
            .recv_timeout(IO_DRAIN_TIMEOUT)
            .map_err(|_| format!("Timed out draining Codex {name}."))?
    }

    fn receive_writer(receiver: Option<Receiver<Result<(), String>>>) -> Result<(), String> {
        let Some(receiver) = receiver else {
            return Ok(());
        };
        receiver
            .recv_timeout(IO_DRAIN_TIMEOUT)
            .map_err(|_| "Timed out draining Codex input.".to_string())?
    }

    enum RunEnd {
        Exited(u32),
        Cancelled,
        TimedOut,
        OutputLimitExceeded,
        Failed(String),
    }

    pub(super) fn run(
        executable: &Path,
        args: &[OsString],
        stdin_body: Option<&str>,
        working_dir: &Path,
        timeout: Duration,
        cancelled: &AtomicBool,
        output_limits: OutputLimits,
    ) -> Result<ProcessResult, String> {
        if cancelled.load(Ordering::Acquire) {
            return Ok(ProcessResult::Cancelled);
        }
        let started = Instant::now();
        let (mut process, io) = SuspendedProcess::spawn(executable, args, working_dir)?;
        let ProcessIo {
            stdin,
            stdout,
            stderr,
        } = io;

        let stdout_budget = Arc::new(OutputBudget::new(
            usize::try_from(output_limits.stdout).unwrap_or(usize::MAX),
        ));
        let stderr_budget = Arc::new(OutputBudget::new(
            usize::try_from(output_limits.stderr).unwrap_or(usize::MAX),
        ));
        let io_failed = Arc::new(AtomicBool::new(false));
        let stdout_receiver = start_reader(
            "stdout",
            stdout,
            Arc::clone(&stdout_budget),
            Arc::clone(&io_failed),
        )?;
        let stderr_receiver = start_reader(
            "stderr",
            stderr,
            Arc::clone(&stderr_budget),
            Arc::clone(&io_failed),
        )?;
        let stdin_receiver = start_writer(stdin, stdin_body)?;

        let end = match process.resume() {
            Err(error) => RunEnd::Failed(error),
            Ok(()) => loop {
                if cancelled.load(Ordering::Acquire) {
                    break RunEnd::Cancelled;
                }
                if started.elapsed() >= timeout {
                    break RunEnd::TimedOut;
                }
                if stdout_budget.overflowed.load(Ordering::Acquire)
                    || stderr_budget.overflowed.load(Ordering::Acquire)
                {
                    break RunEnd::OutputLimitExceeded;
                }
                if io_failed.load(Ordering::Acquire) {
                    break RunEnd::Failed("Could not capture Codex CLI output.".to_string());
                }
                match process.poll() {
                    Ok(Some(code)) => break RunEnd::Exited(code),
                    Ok(None) => {}
                    Err(error) => break RunEnd::Failed(error),
                }
                std::thread::sleep(POLL_INTERVAL);
            },
        };

        // The root may have exited while descendants still own pipe handles.
        // Always terminate the whole job, then bounded-drain every worker before
        // returning on success, cancellation, timeout, overflow, or error.
        process.terminate_tree_and_wait();
        let stdout = receive_capture(stdout_receiver, "stdout");
        let stderr = receive_capture(stderr_receiver, "stderr");
        let stdin = receive_writer(stdin_receiver);
        let overflowed = stdout_budget.overflowed.load(Ordering::Acquire)
            || stderr_budget.overflowed.load(Ordering::Acquire);

        match end {
            RunEnd::Cancelled => Ok(ProcessResult::Cancelled),
            RunEnd::TimedOut => Ok(ProcessResult::TimedOut),
            RunEnd::OutputLimitExceeded => Ok(ProcessResult::OutputLimitExceeded),
            RunEnd::Failed(error) => Err(error),
            RunEnd::Exited(exit_code) => {
                if overflowed {
                    return Ok(ProcessResult::OutputLimitExceeded);
                }
                let stdout = stdout?;
                let stderr = stderr?;
                if exit_code == 0 {
                    stdin?;
                }
                Ok(ProcessResult::Finished {
                    success: exit_code == 0,
                    code: Some(exit_code as i32),
                    stdout: String::from_utf8_lossy(&stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&stderr).into_owned(),
                })
            }
        }
    }
}

fn one_line(value: &str, max_chars: usize) -> Option<String> {
    let clean = value
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>();
    (!clean.trim().is_empty()).then(|| clean.trim().to_string())
}

fn authentication_label(output: &str) -> String {
    let lower = output.to_ascii_lowercase();
    if lower.contains("chatgpt") {
        "ChatGPT".to_string()
    } else if lower.contains("api key") {
        "API key".to_string()
    } else if lower.contains("access token") {
        "access token".to_string()
    } else {
        "CLI managed".to_string()
    }
}

fn resolve_codex_executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        windows_process::resolve_native_executable(OsStr::new("codex"))
    }
    #[cfg(not(windows))]
    {
        Err("Codex CLI integration is available only on Windows.".to_string())
    }
}

fn codex_help_output(
    executable: &Path,
    working_dir: &Path,
    args: &[OsString],
    cancelled: &AtomicBool,
) -> Result<String, String> {
    match run_command(
        executable,
        args,
        None,
        working_dir,
        STATUS_TIMEOUT,
        cancelled,
        STATUS_OUTPUT_LIMITS,
    )? {
        ProcessResult::Finished {
            success: true,
            stdout,
            stderr,
            ..
        } => Ok(format!("{stdout}\n{stderr}")),
        _ => Err("Codex CLI could not describe its supported commands.".to_string()),
    }
}

fn help_supports_required_capabilities(help: &str) -> bool {
    [
        "--ask-for-approval",
        "--strict-config",
        "--config",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "--output-schema",
    ]
    .iter()
    .all(|flag| help.contains(flag))
}

fn validate_required_capabilities(
    executable: &Path,
    working_dir: &Path,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let global = codex_help_output(
        executable,
        working_dir,
        &[OsString::from("--help")],
        cancelled,
    )?;
    let exec = codex_help_output(
        executable,
        working_dir,
        &[OsString::from("exec"), OsString::from("--help")],
        cancelled,
    )?;
    let help = format!("{global}\n{exec}");
    if help_supports_required_capabilities(&help) {
        Ok(())
    } else {
        Err(
            "This Codex CLI version does not support the isolated translation mode required by the app. Update Codex CLI."
                .to_string(),
        )
    }
}

fn check_status_sync() -> CodexCliStatus {
    let executable = match resolve_codex_executable() {
        Ok(executable) => executable,
        Err(error) => {
            return CodexCliStatus {
                installed: false,
                authenticated: false,
                version: None,
                authentication: None,
                error: Some(error),
            };
        }
    };
    let temp = match TempRunDir::create("codex-status") {
        Ok(temp) => temp,
        Err(error) => {
            return CodexCliStatus {
                installed: false,
                authenticated: false,
                version: None,
                authentication: None,
                error: Some(error),
            };
        }
    };
    let never_cancel = AtomicBool::new(false);
    let version = run_command(
        &executable,
        &[OsString::from("--version")],
        None,
        &temp.path,
        STATUS_TIMEOUT,
        &never_cancel,
        STATUS_OUTPUT_LIMITS,
    );
    let version = match version {
        Ok(ProcessResult::Finished {
            success: true,
            stdout,
            ..
        }) => one_line(&stdout, 100),
        Ok(ProcessResult::TimedOut) => {
            return CodexCliStatus {
                installed: false,
                authenticated: false,
                version: None,
                authentication: None,
                error: Some("Codex CLI did not answer the version check in time.".to_string()),
            };
        }
        _ => {
            return CodexCliStatus {
                installed: false,
                authenticated: false,
                version: None,
                authentication: None,
                error: Some("Codex CLI was not found or could not be started.".to_string()),
            };
        }
    };

    if let Err(error) = validate_required_capabilities(&executable, &temp.path, &never_cancel) {
        return CodexCliStatus {
            installed: true,
            authenticated: false,
            version,
            authentication: None,
            error: Some(error),
        };
    }

    let login = run_command(
        &executable,
        &[OsString::from("login"), OsString::from("status")],
        None,
        &temp.path,
        STATUS_TIMEOUT,
        &never_cancel,
        STATUS_OUTPUT_LIMITS,
    );
    match login {
        Ok(ProcessResult::Finished {
            success: true,
            stdout,
            stderr,
            ..
        }) => {
            let output = format!("{stdout}\n{stderr}");
            CodexCliStatus {
                installed: true,
                authenticated: true,
                version,
                authentication: Some(authentication_label(&output)),
                error: None,
            }
        }
        Ok(ProcessResult::TimedOut) => CodexCliStatus {
            installed: true,
            authenticated: false,
            version,
            authentication: None,
            error: Some("Codex CLI did not answer the login-status check in time.".to_string()),
        },
        _ => CodexCliStatus {
            installed: true,
            authenticated: false,
            version,
            authentication: None,
            error: Some("Codex CLI is not signed in. Run `codex login` first.".to_string()),
        },
    }
}

pub async fn status() -> CodexCliStatus {
    tauri::async_runtime::spawn_blocking(check_status_sync)
        .await
        .unwrap_or_else(|_| CodexCliStatus {
            installed: false,
            authenticated: false,
            version: None,
            authentication: None,
            error: Some("Could not check Codex CLI status.".to_string()),
        })
}

fn translation_args(
    working_dir: &Path,
    schema_path: &Path,
    model: &str,
    reasoning: &str,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("--ask-for-approval"),
        OsString::from("never"),
        OsString::from("--strict-config"),
        OsString::from("exec"),
        OsString::from("--ephemeral"),
        OsString::from("--ignore-user-config"),
        OsString::from("--ignore-rules"),
        OsString::from("--sandbox"),
        OsString::from("read-only"),
        OsString::from("--skip-git-repo-check"),
        OsString::from("--color"),
        OsString::from("never"),
        OsString::from("--cd"),
        working_dir.as_os_str().to_os_string(),
        OsString::from("--output-schema"),
        schema_path.as_os_str().to_os_string(),
        OsString::from("--config"),
        OsString::from("web_search=\"disabled\""),
        OsString::from("--config"),
        OsString::from("features.shell_tool=false"),
        OsString::from("--config"),
        OsString::from(format!("model_reasoning_effort=\"{reasoning}\"")),
    ];
    if !model.trim().is_empty() {
        args.push(OsString::from("--model"));
        args.push(OsString::from(model.trim()));
    }
    args.push(OsString::from("-"));
    args
}

pub async fn translate_chunk(
    model: &str,
    reasoning: &str,
    target_language: &str,
    items: &[PreparedAiItem],
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<ProviderTranslation>, ProviderFailure> {
    let reasoning = ai::normalize_reasoning(reasoning)?;
    let prompt = ai::build_provider_prompt(target_language, items)?;
    let model = model.to_string();
    let expected = items.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let executable = resolve_codex_executable().map_err(ProviderFailure::Message)?;
        let temp = TempRunDir::create("codex-translation")?;
        let schema_path = temp.path.join("translation.schema.json");
        let schema = serde_json::to_vec(&prompt.schema)
            .map_err(|error| format!("Could not prepare the Codex output schema: {error}"))?;
        std::fs::write(&schema_path, schema)
            .map_err(|error| format!("Could not write the Codex output schema: {error}"))?;
        let input = format!("{}\n\nInput JSON:\n{}", prompt.instructions, prompt.input);
        let args = translation_args(&temp.path, &schema_path, &model, &reasoning);
        match run_command(
            &executable,
            &args,
            Some(&input),
            &temp.path,
            TRANSLATION_TIMEOUT,
            &cancelled,
            TRANSLATION_OUTPUT_LIMITS,
        )? {
            ProcessResult::Cancelled => Err(ProviderFailure::Cancelled),
            ProcessResult::TimedOut => Err(ProviderFailure::Message(
                "Codex CLI timed out before completing this translation chunk.".to_string(),
            )),
            ProcessResult::OutputLimitExceeded => Err(ProviderFailure::Message(
                "Codex CLI returned more output than this app can safely review.".to_string(),
            )),
            ProcessResult::Finished {
                success: false,
                code,
                stdout,
                stderr,
            } => {
                let diagnostics = format!("{stdout}\n{stderr}").to_ascii_lowercase();
                let message = if diagnostics.contains("not logged in")
                    || diagnostics.contains("authentication")
                    || diagnostics.contains("unauthorized")
                {
                    "Codex CLI is not signed in. Check its status in Settings.".to_string()
                } else {
                    format!(
                        "Codex CLI could not complete the translation chunk (exit code {}).",
                        code.map_or_else(|| "unavailable".to_string(), |code| code.to_string())
                    )
                };
                Err(ProviderFailure::Message(message))
            }
            ProcessResult::Finished {
                success: true,
                stdout,
                ..
            } => {
                let parsed = ai::parse_provider_output(&stdout)?;
                ai::validate_provider_output(&expected, parsed).map_err(ProviderFailure::Message)
            }
        }
    })
    .await
    .map_err(|_| {
        ProviderFailure::Message("The Codex CLI worker stopped unexpectedly.".to_string())
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::sync::atomic::Ordering;

    #[test]
    fn status_parser_exposes_only_a_bounded_auth_label() {
        assert_eq!(authentication_label("Logged in using ChatGPT"), "ChatGPT");
        assert_eq!(authentication_label("logged in using API key"), "API key");
        assert_eq!(authentication_label("some future auth"), "CLI managed");
    }

    #[test]
    fn capability_probe_rejects_a_cli_missing_isolation_flags() {
        let supported = "--ask-for-approval --strict-config --config --ephemeral \
            --ignore-user-config --ignore-rules --sandbox --output-schema";
        assert!(help_supports_required_capabilities(supported));
        assert!(!help_supports_required_capabilities(
            &supported.replace("--ignore-rules", "")
        ));
    }

    #[test]
    fn exec_arguments_are_ephemeral_read_only_and_do_not_enable_tools() {
        let args = translation_args(
            Path::new(r"C:\Temp\empty"),
            Path::new(r"C:\Temp\schema.json"),
            "",
            "medium",
        );
        let args: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));
        assert!(args.contains(&"--ephemeral".to_string()));
        assert!(args.contains(&"--ignore-user-config".to_string()));
        assert!(args.contains(&"--ignore-rules".to_string()));
        assert!(args.contains(&"--strict-config".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--ask-for-approval", "never"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--config", "web_search=\"disabled\""]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--config", "features.shell_tool=false"]));
        assert!(!args.contains(&"--output-last-message".to_string()));
        assert!(!args.contains(&"--model".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[cfg(windows)]
    fn fake_runner_args() -> Vec<OsString> {
        vec![
            OsString::from("fake_runner_entrypoint"),
            OsString::from("--ignored"),
            OsString::from("--nocapture"),
            OsString::from("--test-threads=1"),
        ]
    }

    #[cfg(windows)]
    fn run_fake(
        temp: &TempRunDir,
        mode: &str,
        stdin_body: Option<&str>,
        timeout: Duration,
        cancelled: &AtomicBool,
    ) -> ProcessResult {
        run_fake_with_limits(
            temp,
            mode,
            stdin_body,
            timeout,
            cancelled,
            STATUS_OUTPUT_LIMITS,
        )
    }

    #[cfg(windows)]
    fn run_fake_with_limits(
        temp: &TempRunDir,
        mode: &str,
        stdin_body: Option<&str>,
        timeout: Duration,
        cancelled: &AtomicBool,
        output_limits: OutputLimits,
    ) -> ProcessResult {
        std::fs::write(temp.path.join("fake-mode.txt"), mode).unwrap();
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        run_command(
            &executable,
            &fake_runner_args(),
            stdin_body,
            &temp.path,
            timeout,
            cancelled,
            output_limits,
        )
        .unwrap()
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "entry point for direct process-runner tests"]
    fn fake_runner_entrypoint() {
        use std::io::Write as _;

        let mode = std::fs::read_to_string("fake-mode.txt").unwrap();
        match mode.trim() {
            "small" => {
                std::io::stdout().write_all(b"codex-cli fake").unwrap();
                std::io::stdout().flush().unwrap();
            }
            "sleep" => std::thread::sleep(Duration::from_secs(30)),
            "stdout-overflow" => {
                let body = vec![b'x'; MAX_DIAGNOSTIC_OUTPUT_BYTES as usize + 8 * 1024];
                std::io::stdout().write_all(&body).unwrap();
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            "stderr-overflow" => {
                let body = vec![b'x'; MAX_DIAGNOSTIC_OUTPUT_BYTES as usize + 8 * 1024];
                std::io::stderr().write_all(&body).unwrap();
                std::io::stderr().flush().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            "large-stdout" => {
                let body = vec![b'x'; MAX_DIAGNOSTIC_OUTPUT_BYTES as usize + 8 * 1024];
                std::io::stdout().write_all(&body).unwrap();
                std::io::stdout().flush().unwrap();
            }
            "final-overflow" => {
                let body = vec![b'x'; MAX_FINAL_OUTPUT_BYTES as usize + 1];
                std::io::stdout().write_all(&body).unwrap();
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            unexpected => panic!("unexpected fake-runner mode: {unexpected}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn direct_runner_captures_a_small_fake_executable_result() {
        let temp = TempRunDir::create("fake-codex").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run_fake(&temp, "small", None, Duration::from_secs(10), &cancelled);
        assert!(matches!(
            result,
            ProcessResult::Finished {
                success: true,
                ref stdout,
                ..
            } if stdout.contains("codex-cli fake")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn timeout_is_not_blocked_by_a_full_stdin_pipe() {
        let temp = TempRunDir::create("fake-codex-timeout").unwrap();
        let cancelled = AtomicBool::new(false);
        let body = "x".repeat(2 * 1024 * 1024);
        let result = run_fake(
            &temp,
            "sleep",
            Some(&body),
            Duration::from_millis(100),
            &cancelled,
        );
        assert!(matches!(result, ProcessResult::TimedOut));
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_terminates_the_direct_runner() {
        let temp = TempRunDir::create("fake-codex-cancel").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let setter = Arc::clone(&cancelled);
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            setter.store(true, Ordering::Release);
        });
        let result = run_fake(&temp, "sleep", None, Duration::from_secs(10), &cancelled);
        cancel_thread.join().unwrap();
        assert!(matches!(result, ProcessResult::Cancelled));
    }

    #[cfg(windows)]
    #[test]
    fn diagnostic_output_limit_terminates_the_direct_runner() {
        let temp = TempRunDir::create("fake-codex-output").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run_fake(
            &temp,
            "stdout-overflow",
            None,
            Duration::from_secs(10),
            &cancelled,
        );
        assert!(matches!(result, ProcessResult::OutputLimitExceeded));
    }

    #[cfg(windows)]
    #[test]
    fn stdout_and_stderr_limits_are_independent() {
        let temp = TempRunDir::create("fake-codex-independent-limits").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run_fake_with_limits(
            &temp,
            "large-stdout",
            None,
            Duration::from_secs(10),
            &cancelled,
            TRANSLATION_OUTPUT_LIMITS,
        );
        assert!(matches!(
            result,
            ProcessResult::Finished { success: true, .. }
        ));

        let result = run_fake_with_limits(
            &temp,
            "stderr-overflow",
            None,
            Duration::from_secs(10),
            &cancelled,
            TRANSLATION_OUTPUT_LIMITS,
        );
        assert!(matches!(result, ProcessResult::OutputLimitExceeded));
    }

    #[cfg(windows)]
    #[test]
    fn final_stdout_limit_is_enforced_while_the_runner_is_alive() {
        let temp = TempRunDir::create("fake-codex-final-output").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run_fake_with_limits(
            &temp,
            "final-overflow",
            None,
            Duration::from_secs(10),
            &cancelled,
            TRANSLATION_OUTPUT_LIMITS,
        );
        assert!(matches!(result, ProcessResult::OutputLimitExceeded));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an installed, signed-in Codex CLI and network access"]
    fn live_codex_adapter_translates_only_synthetic_text() {
        let status = check_status_sync();
        assert!(
            status.installed,
            "{}",
            status.error.as_deref().unwrap_or_default()
        );
        assert!(
            status.authenticated,
            "{}",
            status.error.as_deref().unwrap_or_default()
        );
        let items = vec![PreparedAiItem {
            id: "item-0000".to_string(),
            identity: crate::ai::AiStringIdentity {
                mod_unique_id: "synthetic.test".to_string(),
                relative_dir: "i18n".to_string(),
                key: "greeting".to_string(),
            },
            source: "Hello, farmer!".to_string(),
            section: Some("Synthetic fixture".to_string()),
            glossary_pairs: Vec::new(),
            default_path: PathBuf::from(r"C:\synthetic\default.json"),
            target_path: PathBuf::from(r"C:\synthetic\de.json"),
            expected_stored: None,
            expected_revision: 0,
        }];
        let translated = tauri::async_runtime::block_on(translate_chunk(
            "",
            "low",
            "German",
            &items,
            Arc::new(AtomicBool::new(false)),
        ))
        .unwrap();
        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0].id, "item-0000");
        assert!(!translated[0].text.trim().is_empty());
    }
}
