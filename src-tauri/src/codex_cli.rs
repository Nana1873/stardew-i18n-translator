//! Direct Codex CLI adapter.
//!
//! The app asks the installed CLI for version/login status and uses
//! `codex exec` for bounded structured translation chunks. It never reads the
//! CLI's auth/config files or receives an auth token.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::ai::{self, PreparedAiItem, ProviderFailure, ProviderTranslation};
use crate::ai_provider::*;

include!("cloud_translation.rs");

const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const APP_SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const TRANSLATION_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_DIAGNOSTIC_OUTPUT_BYTES: u64 = 128 * 1024;
const MAX_FINAL_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;
// JSONL includes an escaped agent-message copy of the separately bounded final
// output plus event envelopes. Keep it independently bounded with headroom.
const MAX_TRANSLATION_JSONL_BYTES: u64 = 8 * 1024 * 1024;

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
    stdout: MAX_TRANSLATION_JSONL_BYTES,
    stderr: MAX_DIAGNOSTIC_OUTPUT_BYTES,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelListResponse {
    result: Option<ModelListResult>,
    error: Option<ModelListError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelListResult {
    data: Vec<ModelListEntry>,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelListError {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelListEntry {
    model: String,
    display_name: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    default_reasoning_effort: Option<String>,
    #[serde(default)]
    supported_reasoning_efforts: Vec<ModelReasoningEffort>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelReasoningEffort {
    reasoning_effort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitsResponse {
    result: Option<RateLimitsResult>,
    error: Option<AppServerError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitsResult {
    rate_limits: Option<RateLimitSnapshot>,
    #[serde(default)]
    rate_limits_by_limit_id: Option<HashMap<String, RateLimitSnapshot>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitSnapshot {
    #[serde(default)]
    primary: Option<RateLimitWindow>,
    #[serde(default)]
    secondary: Option<RateLimitWindow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitWindow {
    used_percent: Option<f64>,
    window_duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AppServerError {
    code: Option<i64>,
    message: Option<String>,
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

type ProcessLineCallback = Arc<dyn Fn(&[u8]) + Send + Sync>;

struct ProcessOptions<'a> {
    working_dir: &'a Path,
    timeout: Duration,
    cancelled: &'a AtomicBool,
    output_limits: OutputLimits,
    stdout_line: Option<ProcessLineCallback>,
}

fn run_command(
    executable: &Path,
    args: &[OsString],
    stdin_body: Option<&str>,
    options: ProcessOptions<'_>,
) -> Result<ProcessResult, String> {
    #[cfg(windows)]
    {
        windows_process::run(executable, args, stdin_body, options)
    }
    #[cfg(not(windows))]
    {
        let _ = (executable, args, stdin_body, options);
        Err("Codex CLI integration is available only on Windows.".to_string())
    }
}

fn run_app_server_request(
    executable: &Path,
    initialize: &str,
    request: &str,
    request_id: u64,
    working_dir: &Path,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        windows_process::run_jsonl_request(
            executable,
            &app_server_args(),
            initialize,
            request,
            request_id,
            working_dir,
            APP_SERVER_REQUEST_TIMEOUT,
            STATUS_OUTPUT_LIMITS,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (executable, initialize, request, request_id, working_dir);
        Err("Codex CLI integration is available only on Windows.".to_string())
    }
}

fn app_server_args() -> [OsString; 2] {
    // These status reads are read-only and must tolerate a newer Codex Desktop
    // config than the installed CLI understands. Translation runs remain
    // strict and ignore user config entirely.
    [OsString::from("app-server"), OsString::from("--stdio")]
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

    use super::{OutputLimits, ProcessLineCallback, ProcessOptions, ProcessResult};

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

    fn official_install_directory(local_app_data: Option<&OsStr>) -> Option<PathBuf> {
        let local_app_data = local_app_data.filter(|value| !value.is_empty())?;
        let local_app_data = Path::new(local_app_data);
        if !local_app_data.is_absolute() {
            return None;
        }
        Some(
            local_app_data
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin"),
        )
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

    fn resolve_native_executable_from(
        requested: &OsStr,
        directories: &[PathBuf],
        official_directory: Option<&Path>,
    ) -> Result<PathBuf, String> {
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

        for directory in directories {
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
        // The official standalone Windows installer defaults here. Check it
        // only after PATH-based native and npm installations so this remains a
        // fallback for apps launched before Explorer inherited the new PATH.
        if let Some(directory) = official_directory {
            if let Some(executable) = canonical_exe(&directory.join(&executable_name)) {
                return Ok(executable);
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
                "Codex CLI was not found. Install it in the default Windows location or make its native codex.exe available on PATH."
                    .to_string(),
            )
        }
    }

    pub(super) fn resolve_native_executable(requested: &OsStr) -> Result<PathBuf, String> {
        let directories = executable_search_dirs();
        let local_app_data = std::env::var_os("LOCALAPPDATA");
        let official_directory = official_install_directory(local_app_data.as_deref());
        resolve_native_executable_from(requested, &directories, official_directory.as_deref())
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
        line_callback: Option<ProcessLineCallback>,
    ) -> Result<Receiver<Result<Vec<u8>, String>>, String> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name(format!("codex-{name}"))
            .spawn(move || {
                let mut captured = Vec::new();
                let mut pending_line = Vec::new();
                let mut chunk = [0u8; 8 * 1024];
                let result = loop {
                    match file.read(&mut chunk) {
                        Ok(0) => {
                            if let Some(callback) = &line_callback {
                                if !pending_line.is_empty() {
                                    callback(&pending_line);
                                }
                            }
                            break Ok(captured);
                        }
                        Ok(read) => {
                            let keep = budget.reserve(read);
                            captured.extend_from_slice(&chunk[..keep]);
                            if let Some(callback) = &line_callback {
                                pending_line.extend_from_slice(&chunk[..keep]);
                                while let Some(newline) =
                                    pending_line.iter().position(|byte| *byte == b'\n')
                                {
                                    let line = pending_line.drain(..=newline).collect::<Vec<_>>();
                                    callback(&line);
                                }
                            }
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

    fn start_line_reader(
        mut file: File,
        budget: Arc<OutputBudget>,
        io_failed: Arc<AtomicBool>,
    ) -> Result<Receiver<Result<Vec<u8>, String>>, String> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("codex-stdout-jsonl".to_string())
            .spawn(move || {
                let mut pending = Vec::new();
                let mut chunk = [0u8; 8 * 1024];
                loop {
                    match file.read(&mut chunk) {
                        Ok(0) => {
                            if !pending.is_empty() {
                                let _ = sender.send(Ok(pending));
                            }
                            break;
                        }
                        Ok(read) => {
                            let keep = budget.reserve(read);
                            pending.extend_from_slice(&chunk[..keep]);
                            while let Some(newline) = pending.iter().position(|byte| *byte == b'\n')
                            {
                                let line = pending.drain(..=newline).collect::<Vec<_>>();
                                if sender.send(Ok(line)).is_err() {
                                    return;
                                }
                            }
                            if keep < read {
                                break;
                            }
                        }
                        Err(error) => {
                            io_failed.store(true, Ordering::Release);
                            let _ = sender.send(Err(format!(
                                "Could not read Codex app-server output: {error}"
                            )));
                            break;
                        }
                    }
                }
            })
            .map_err(|error| format!("Could not start the Codex JSONL reader: {error}"))?;
        Ok(receiver)
    }

    fn write_json_line(file: &mut File, body: &str) -> Result<(), String> {
        file.write_all(body.as_bytes())
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.flush())
            .map_err(|error| format!("Could not send a request to Codex app-server: {error}"))
    }

    #[allow(clippy::too_many_arguments)]
    fn wait_for_json_response(
        process: &SuspendedProcess,
        receiver: &Receiver<Result<Vec<u8>, String>>,
        response_id: u64,
        started: Instant,
        timeout: Duration,
        stdout_budget: &OutputBudget,
        stderr_budget: &OutputBudget,
        io_failed: &AtomicBool,
    ) -> Result<String, String> {
        loop {
            if started.elapsed() >= timeout {
                return Err("Codex CLI did not return the app-server response in time.".to_string());
            }
            if stdout_budget.overflowed.load(Ordering::Acquire)
                || stderr_budget.overflowed.load(Ordering::Acquire)
            {
                return Err("Codex CLI returned too much app-server output.".to_string());
            }
            if io_failed.load(Ordering::Acquire) {
                return Err("Could not capture Codex app-server output.".to_string());
            }

            match receiver.recv_timeout(POLL_INTERVAL) {
                Ok(Ok(line)) => {
                    let Ok(response) = serde_json::from_slice::<serde_json::Value>(&line) else {
                        // The native CLI protocol is JSONL, but a launcher may
                        // write its own bounded diagnostics to stdout. Ignore
                        // those lines and continue routing by response id.
                        continue;
                    };
                    if response.get("id").and_then(serde_json::Value::as_u64) == Some(response_id) {
                        return String::from_utf8(line).map_err(|_| {
                            "Codex CLI returned non-UTF-8 app-server data.".to_string()
                        });
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(code) = process.poll()? {
                        return Err(format!(
                            "Codex app-server stopped before returning the requested response (exit code {code})."
                        ));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(
                        "Codex app-server closed before returning the requested response."
                            .to_string(),
                    );
                }
            }
        }
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
        options: ProcessOptions<'_>,
    ) -> Result<ProcessResult, String> {
        let ProcessOptions {
            working_dir,
            timeout,
            cancelled,
            output_limits,
            stdout_line,
        } = options;
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
            stdout_line,
        )?;
        let stderr_receiver = start_reader(
            "stderr",
            stderr,
            Arc::clone(&stderr_budget),
            Arc::clone(&io_failed),
            None,
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

    #[allow(clippy::too_many_arguments)]
    pub(super) fn run_jsonl_request(
        executable: &Path,
        args: &[OsString],
        initialize: &str,
        request: &str,
        request_id: u64,
        working_dir: &Path,
        timeout: Duration,
        output_limits: OutputLimits,
    ) -> Result<String, String> {
        let started = Instant::now();
        let (mut process, io) = SuspendedProcess::spawn(executable, args, working_dir)?;
        let ProcessIo {
            mut stdin,
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
        let stdout_receiver =
            start_line_reader(stdout, Arc::clone(&stdout_budget), Arc::clone(&io_failed))?;
        let stderr_receiver = start_reader(
            "stderr",
            stderr,
            Arc::clone(&stderr_budget),
            Arc::clone(&io_failed),
            None,
        )?;

        let exchange = (|| {
            process.resume()?;
            write_json_line(&mut stdin, initialize)?;
            let initialized = wait_for_json_response(
                &process,
                &stdout_receiver,
                1,
                started,
                timeout,
                &stdout_budget,
                &stderr_budget,
                &io_failed,
            )?;
            let initialized: serde_json::Value = serde_json::from_str(&initialized)
                .map_err(|_| "Codex CLI returned invalid initialization data.".to_string())?;
            if initialized.get("error").is_some() {
                return Err("Codex app-server rejected initialization.".to_string());
            }

            write_json_line(&mut stdin, r#"{"method":"initialized"}"#)?;
            write_json_line(&mut stdin, request)?;
            wait_for_json_response(
                &process,
                &stdout_receiver,
                request_id,
                started,
                timeout,
                &stdout_budget,
                &stderr_budget,
                &io_failed,
            )
        })();

        // Closing stdin lets the one-shot app-server stop. The job-object
        // termination remains the bounded fallback for every outcome.
        drop(stdin);
        process.terminate_tree_and_wait();
        drop(stdout_receiver);
        let stderr = receive_capture(stderr_receiver, "stderr");
        let overflowed = stdout_budget.overflowed.load(Ordering::Acquire)
            || stderr_budget.overflowed.load(Ordering::Acquire);
        if overflowed {
            return Err("Codex CLI returned too much app-server output.".to_string());
        }
        stderr?;
        exchange
    }

    #[cfg(test)]
    mod executable_resolution_tests {
        use super::super::TempRunDir;
        use super::*;

        fn create_test_executable(path: &Path) -> PathBuf {
            std::fs::create_dir_all(path.parent().expect("test executable should have a parent"))
                .expect("test executable parent should be created");
            std::fs::File::create(path).expect("test executable should be created");
            path.canonicalize()
                .expect("test executable should canonicalize")
        }

        #[test]
        fn official_install_directory_uses_the_windows_default() {
            assert_eq!(
                official_install_directory(Some(OsStr::new(r"C:\Users\Test\AppData\Local"))),
                Some(PathBuf::from(
                    r"C:\Users\Test\AppData\Local\Programs\OpenAI\Codex\bin"
                ))
            );
        }

        #[test]
        fn invalid_local_app_data_does_not_add_a_relative_fallback() {
            assert_eq!(official_install_directory(None), None);
            assert_eq!(official_install_directory(Some(OsStr::new(""))), None);
            assert_eq!(
                official_install_directory(Some(OsStr::new(r"relative\local"))),
                None
            );
            assert_eq!(
                official_install_directory(Some(OsStr::new(r"C:drive-relative"))),
                None
            );
        }

        #[test]
        fn path_native_executable_wins_over_official_fallback() {
            let temp = TempRunDir::create("codex-path-precedence")
                .expect("test directory should be created");
            let path_directory = temp.path.join("path");
            let official_directory = temp.path.join("official");
            let expected = create_test_executable(&path_directory.join("codex.exe"));
            create_test_executable(&official_directory.join("codex.exe"));

            let resolved = resolve_native_executable_from(
                OsStr::new("codex"),
                &[path_directory],
                Some(&official_directory),
            )
            .expect("PATH executable should resolve");

            assert_eq!(resolved, expected);
        }

        #[test]
        fn npm_native_executable_wins_over_official_fallback() {
            let temp = TempRunDir::create("codex-npm-precedence")
                .expect("test directory should be created");
            let shim_directory = temp.path.join("npm");
            let official_directory = temp.path.join("official");
            std::fs::create_dir_all(&shim_directory).expect("shim directory should be created");
            std::fs::File::create(shim_directory.join("codex.cmd"))
                .expect("test shim should be created");
            let npm_candidate = npm_native_candidates(&shim_directory)
                .into_iter()
                .next()
                .expect("Windows architecture should be supported");
            let expected = create_test_executable(&npm_candidate);
            create_test_executable(&official_directory.join("codex.exe"));

            let resolved = resolve_native_executable_from(
                OsStr::new("codex"),
                &[shim_directory],
                Some(&official_directory),
            )
            .expect("npm native executable should resolve");

            assert_eq!(resolved, expected);
        }

        #[test]
        fn official_fallback_resolves_after_stale_search_directories() {
            let temp = TempRunDir::create("codex-official-fallback")
                .expect("test directory should be created");
            let stale_directory = temp.path.join("stale-path");
            let official_directory = temp.path.join("official");
            std::fs::create_dir_all(&stale_directory)
                .expect("stale PATH directory should be created");
            let expected = create_test_executable(&official_directory.join("codex.exe"));

            let resolved = resolve_native_executable_from(
                OsStr::new("codex"),
                &[stale_directory],
                Some(&official_directory),
            )
            .expect("official fallback should resolve");

            assert_eq!(resolved, expected);
        }

        #[test]
        fn command_shim_request_remains_rejected_with_official_fallback() {
            let error = resolve_native_executable_from(
                OsStr::new("codex.cmd"),
                &[],
                Some(Path::new(r"C:\Users\Test\AppData\Local")),
            )
            .expect_err("command shim should be rejected");

            assert!(error.contains("command shims are not executed"));
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

fn installed_status_error(error: impl Into<String>) -> CloudAiStatus {
    CloudAiStatus {
        installed: true,
        authenticated: false,
        version: None,
        authentication: None,
        error: Some(error.into()),
    }
}

fn version_from_status_probe(
    result: Result<ProcessResult, String>,
) -> Result<Option<String>, CloudAiStatus> {
    match result {
        Ok(ProcessResult::Finished {
            success: true,
            stdout,
            ..
        }) => Ok(one_line(&stdout, 100)),
        Ok(ProcessResult::TimedOut) => Err(installed_status_error(
            "Codex CLI did not answer the version check in time.",
        )),
        _ => Err(installed_status_error(
            "Codex CLI was found but could not complete the version check.",
        )),
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
        ProcessOptions {
            working_dir,
            timeout: STATUS_TIMEOUT,
            cancelled,
            output_limits: STATUS_OUTPUT_LIMITS,
            stdout_line: None,
        },
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
        "--output-last-message",
        "--json",
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

fn check_status_sync() -> CloudAiStatus {
    let executable = match resolve_codex_executable() {
        Ok(executable) => executable,
        Err(error) => {
            return CloudAiStatus {
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
            return installed_status_error(error);
        }
    };
    let never_cancel = AtomicBool::new(false);
    let version = run_command(
        &executable,
        &[OsString::from("--version")],
        None,
        ProcessOptions {
            working_dir: &temp.path,
            timeout: STATUS_TIMEOUT,
            cancelled: &never_cancel,
            output_limits: STATUS_OUTPUT_LIMITS,
            stdout_line: None,
        },
    );
    let version = match version_from_status_probe(version) {
        Ok(version) => version,
        Err(status) => return status,
    };

    if let Err(error) = validate_required_capabilities(&executable, &temp.path, &never_cancel) {
        return CloudAiStatus {
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
        ProcessOptions {
            working_dir: &temp.path,
            timeout: STATUS_TIMEOUT,
            cancelled: &never_cancel,
            output_limits: STATUS_OUTPUT_LIMITS,
            stdout_line: None,
        },
    );
    match login {
        Ok(ProcessResult::Finished {
            success: true,
            stdout,
            stderr,
            ..
        }) => {
            let output = format!("{stdout}\n{stderr}");
            CloudAiStatus {
                installed: true,
                authenticated: true,
                version,
                authentication: Some(authentication_label(&output)),
                error: None,
            }
        }
        Ok(ProcessResult::TimedOut) => CloudAiStatus {
            installed: true,
            authenticated: false,
            version,
            authentication: None,
            error: Some("Codex CLI did not answer the login-status check in time.".to_string()),
        },
        _ => CloudAiStatus {
            installed: true,
            authenticated: false,
            version,
            authentication: None,
            error: Some("Codex CLI is not signed in. Run `codex login` first.".to_string()),
        },
    }
}

pub async fn status() -> CloudAiStatus {
    tauri::async_runtime::spawn_blocking(check_status_sync)
        .await
        .unwrap_or_else(|_| CloudAiStatus {
            installed: false,
            authenticated: false,
            version: None,
            authentication: None,
            error: Some("Could not check Codex CLI status.".to_string()),
        })
}

fn app_server_initialize_request() -> String {
    serde_json::json!({
        "method": "initialize",
        "id": 1,
        "params": {
            "clientInfo": {
                "name": "stardew_i18n_translator",
                "title": "Stardew i18n Translator",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    })
    .to_string()
}

fn sanitize_rate_limit_window(window: &RateLimitWindow) -> Option<CloudAiRateLimitWindow> {
    let used_percent = window.used_percent?;
    if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
        return None;
    }
    Some(CloudAiRateLimitWindow {
        used_percent,
        window_duration_mins: window
            .window_duration_mins
            .and_then(|minutes| u64::try_from(minutes).ok()),
        resets_at: window
            .resets_at
            .and_then(|timestamp| u64::try_from(timestamp).ok()),
    })
}

fn sanitize_rate_limit_snapshot(snapshot: &RateLimitSnapshot) -> Option<CloudAiRateLimits> {
    let limits = CloudAiRateLimits {
        primary: snapshot
            .primary
            .as_ref()
            .and_then(sanitize_rate_limit_window),
        secondary: snapshot
            .secondary
            .as_ref()
            .and_then(sanitize_rate_limit_window),
    };
    (limits.primary.is_some() || limits.secondary.is_some()).then_some(limits)
}

fn rate_limits_unavailable(error: &AppServerError) -> bool {
    if error.code == Some(-32601) {
        return true;
    }
    let message = error
        .message
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "authentication required",
        "not authenticated",
        "not signed in",
        "method not found",
        "unknown method",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

fn parse_rate_limits_response(body: &str) -> Result<Option<CloudAiRateLimits>, String> {
    let response: RateLimitsResponse = serde_json::from_str(body)
        .map_err(|_| "Codex CLI returned unreadable ChatGPT usage limits.".to_string())?;
    if let Some(error) = response.error {
        return if rate_limits_unavailable(&error) {
            Ok(None)
        } else {
            Err("Codex CLI could not read ChatGPT usage limits.".to_string())
        };
    }
    let result = response
        .result
        .ok_or_else(|| "Codex CLI returned no ChatGPT usage result.".to_string())?;
    if let Some(limits) = result
        .rate_limits_by_limit_id
        .as_ref()
        .and_then(|limits| limits.get("codex"))
        .and_then(sanitize_rate_limit_snapshot)
    {
        return Ok(Some(limits));
    }
    Ok(result
        .rate_limits
        .as_ref()
        .and_then(sanitize_rate_limit_snapshot))
}

fn rate_limits_request() -> String {
    serde_json::json!({
        "method": "account/rateLimits/read",
        "id": 2
    })
    .to_string()
}

fn read_rate_limits_sync() -> Result<Option<CloudAiRateLimits>, String> {
    let executable = resolve_codex_executable()
        .map_err(|_| "Codex CLI could not read ChatGPT usage limits.".to_string())?;
    let temp = TempRunDir::create("codex-rate-limits")
        .map_err(|_| "Codex CLI could not read ChatGPT usage limits.".to_string())?;
    let request = rate_limits_request();
    let response = run_app_server_request(
        &executable,
        &app_server_initialize_request(),
        &request,
        2,
        &temp.path,
    )
    .map_err(|_| "Codex CLI could not read ChatGPT usage limits.".to_string())?;
    parse_rate_limits_response(&response)
}

pub async fn rate_limits() -> Result<Option<CloudAiRateLimits>, String> {
    tauri::async_runtime::spawn_blocking(read_rate_limits_sync)
        .await
        .map_err(|_| "The Codex CLI usage worker stopped unexpectedly.".to_string())?
}

fn clean_display_name(value: &str, fallback: &str) -> String {
    let value = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect::<String>();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn parse_model_list_response(body: &str) -> Result<ModelListResult, String> {
    let response: ModelListResponse = serde_json::from_str(body)
        .map_err(|_| "Codex CLI returned an unreadable model list.".to_string())?;
    if let Some(error) = response.error {
        let message = one_line(&error.message, 160)
            .unwrap_or_else(|| "The model-list request was rejected.".to_string());
        return Err(format!("Codex CLI could not list models: {message}"));
    }
    response
        .result
        .ok_or_else(|| "Codex CLI returned no model-list result.".to_string())
}

fn list_models_sync() -> Result<Vec<CloudAiModel>, String> {
    const PAGE_LIMIT: usize = 100;
    const MAX_PAGES: usize = 8;
    const MAX_MODELS: usize = 500;

    let executable = resolve_codex_executable()?;
    let temp = TempRunDir::create("codex-models")?;
    let initialize = app_server_initialize_request();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_models = HashSet::new();
    let mut models = Vec::new();

    for _ in 0..MAX_PAGES {
        let mut params = serde_json::json!({
            "limit": PAGE_LIMIT,
            "includeHidden": false
        });
        if let Some(cursor) = cursor.as_deref() {
            params["cursor"] = serde_json::Value::String(cursor.to_string());
        }
        let request = serde_json::json!({
            "method": "model/list",
            "id": 2,
            "params": params
        })
        .to_string();
        let response = run_app_server_request(&executable, &initialize, &request, 2, &temp.path)?;
        let page = parse_model_list_response(&response)?;

        for entry in page.data {
            if entry.hidden || models.len() >= MAX_MODELS {
                continue;
            }
            let Some(model) = clean_model_value(&entry.model) else {
                continue;
            };
            if !seen_models.insert(model.clone()) {
                continue;
            }
            let mut reasoning = entry
                .supported_reasoning_efforts
                .into_iter()
                .filter_map(|effort| ai::normalize_reasoning(&effort.reasoning_effort).ok())
                .collect::<Vec<_>>();
            reasoning.dedup();
            let default_reasoning_effort = entry
                .default_reasoning_effort
                .and_then(|effort| ai::normalize_reasoning(&effort).ok());
            models.push(CloudAiModel {
                display_name: clean_display_name(&entry.display_name, &model),
                model,
                is_default: entry.is_default,
                default_reasoning_effort,
                supported_reasoning_efforts: reasoning,
            });
        }

        let Some(next_cursor) = page.next_cursor.filter(|value| !value.is_empty()) else {
            return Ok(models);
        };
        if models.len() >= MAX_MODELS || !seen_cursors.insert(next_cursor.clone()) {
            return Ok(models);
        }
        cursor = Some(next_cursor);
    }

    Ok(models)
}

pub async fn models() -> Result<Vec<CloudAiModel>, String> {
    tauri::async_runtime::spawn_blocking(list_models_sync)
        .await
        .map_err(|_| "The Codex CLI model-list worker stopped unexpectedly.".to_string())?
}

fn translation_args(
    working_dir: &Path,
    schema_path: &Path,
    final_output_path: &Path,
    model: Option<&str>,
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
    ];
    if let Some(model) = model {
        args.push(OsString::from("--model"));
        args.push(OsString::from(model));
    }
    args.extend([
        OsString::from("--sandbox"),
        OsString::from("read-only"),
        OsString::from("--skip-git-repo-check"),
        OsString::from("--color"),
        OsString::from("never"),
        OsString::from("--cd"),
        working_dir.as_os_str().to_os_string(),
        OsString::from("--output-schema"),
        schema_path.as_os_str().to_os_string(),
        OsString::from("--output-last-message"),
        final_output_path.as_os_str().to_os_string(),
        OsString::from("--json"),
        OsString::from("--config"),
        OsString::from("web_search=\"disabled\""),
        OsString::from("--config"),
        OsString::from("features.shell_tool=false"),
        OsString::from("--config"),
        OsString::from(format!("model_reasoning_effort=\"{reasoning}\"")),
        OsString::from("-"),
    ]);
    args
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CodexJsonlProgress {
    activity: Option<ProviderActivity>,
    usage: Option<ProviderTokenUsage>,
}

#[derive(Deserialize)]
struct CodexJsonlEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    item: Option<CodexJsonlItem>,
    #[serde(default)]
    usage: Option<ProviderTokenUsage>,
}

#[derive(Deserialize)]
struct CodexJsonlItem {
    #[serde(rename = "type")]
    item_type: String,
}

fn parse_jsonl_progress(line: &[u8]) -> Option<CodexJsonlProgress> {
    let event: CodexJsonlEnvelope = serde_json::from_slice(line).ok()?;
    let activity = match event.event_type.as_str() {
        "thread.started" => Some(ProviderActivity::Starting),
        "turn.started" => Some(ProviderActivity::Working),
        "item.started" | "item.updated" | "item.completed" => {
            match event.item.as_ref().map(|item| item.item_type.as_str()) {
                Some("reasoning") => Some(ProviderActivity::Reasoning),
                Some("agent_message") => Some(ProviderActivity::WritingResponse),
                _ => Some(ProviderActivity::Working),
            }
        }
        "turn.completed" => Some(ProviderActivity::Completed),
        "turn.failed" | "error" => Some(ProviderActivity::Failed),
        _ => None,
    };
    let parsed = CodexJsonlProgress {
        activity,
        usage: if event.event_type == "turn.completed" {
            event.usage
        } else {
            None
        },
    };
    (parsed.activity.is_some() || parsed.usage.is_some()).then_some(parsed)
}

fn report_jsonl_progress(line: &[u8], progress: &ProviderProgressCallback) {
    let Some(event) = parse_jsonl_progress(line) else {
        return;
    };
    if let Some(usage) = event.usage {
        progress(ProviderProgressEvent::Usage(usage));
    }
    if let Some(activity) = event.activity {
        progress(ProviderProgressEvent::Activity(activity));
    }
}

fn is_authentication_failure(stdout: &str, stderr: &str) -> bool {
    let diagnostics = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    diagnostics.contains("not logged in")
        || diagnostics.contains("authentication")
        || diagnostics.contains("unauthorized")
}

fn failed_exit(code: Option<i32>, stdout: &str, stderr: &str) -> ProviderFailure {
    if is_authentication_failure(stdout, stderr) {
        ProviderFailure::Message(
            "Codex CLI is not signed in. Check its status in Settings.".to_string(),
        )
    } else {
        ProviderFailure::Transient(format!(
            "Codex CLI could not complete the translation chunk (exit code {}).",
            code.map_or_else(|| "unavailable".to_string(), |code| code.to_string())
        ))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_prompt_once(
    model: Option<String>,
    reasoning: String,
    prompt: ai::ProviderPrompt,
    expected: Vec<PreparedAiItem>,
    output_contract: PromptOutputContract,
    cancelled: Arc<AtomicBool>,
    progress: ProviderProgressCallback,
) -> Result<Vec<ProviderTranslation>, ProviderFailure> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ProviderFailure::Cancelled);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let item_count = expected.len();
        log::info!(
            target: "codex_cli",
            "{}",
            serde_json::json!({
                "event": "attempt_started",
                "itemCount": item_count,
                "model": safe_model_for_log(model.as_deref()),
                "reasoning": reasoning,
            })
        );
        let mut exit_code = None;
        let result = (|| {
            let executable = resolve_codex_executable().map_err(ProviderFailure::Message)?;
            let temp = TempRunDir::create("codex-translation").map_err(ProviderFailure::Message)?;
            let schema_path = temp.path.join("translation.schema.json");
            let final_output_path = temp.path.join("translation.result.json");
            let schema = serde_json::to_vec(&prompt.schema).map_err(|error| {
                ProviderFailure::Message(format!(
                    "Could not prepare the Codex output schema: {error}"
                ))
            })?;
            std::fs::write(&schema_path, schema).map_err(|error| {
                ProviderFailure::Message(format!(
                    "Could not write the Codex output schema: {error}"
                ))
            })?;
            let input = format!(
                "{}{}{}",
                prompt.instructions, PROMPT_INPUT_SEPARATOR, prompt.input
            );
            let args = translation_args(
                &temp.path,
                &schema_path,
                &final_output_path,
                model.as_deref(),
                &reasoning,
            );
            let stdout_progress = Arc::clone(&progress);
            let stdout_line: ProcessLineCallback = Arc::new(move |line| {
                report_jsonl_progress(line, &stdout_progress);
            });
            match run_command(
                &executable,
                &args,
                Some(&input),
                ProcessOptions {
                    working_dir: &temp.path,
                    timeout: TRANSLATION_TIMEOUT,
                    cancelled: &cancelled,
                    output_limits: TRANSLATION_OUTPUT_LIMITS,
                    stdout_line: Some(stdout_line),
                },
            )
            .map_err(ProviderFailure::Message)?
            {
                ProcessResult::Cancelled => Err(ProviderFailure::Cancelled),
                ProcessResult::TimedOut => Err(ProviderFailure::Transient(
                    "Codex CLI timed out before completing this translation chunk.".to_string(),
                )),
                ProcessResult::OutputLimitExceeded => Err(ProviderFailure::InvalidResponse(
                    "Codex CLI returned more output than this app can safely review.".to_string(),
                )),
                ProcessResult::Finished {
                    success: false,
                    code,
                    stdout,
                    stderr,
                } => {
                    exit_code = code;
                    Err(failed_exit(code, &stdout, &stderr))
                }
                ProcessResult::Finished {
                    success: true,
                    code,
                    ..
                } => {
                    exit_code = code;
                    let metadata = std::fs::metadata(&final_output_path).map_err(|_| {
                        ProviderFailure::InvalidResponse(
                            "Codex CLI did not write its final structured response.".to_string(),
                        )
                    })?;
                    if metadata.len() > MAX_FINAL_OUTPUT_BYTES {
                        return Err(ProviderFailure::InvalidResponse(
                            "Codex CLI returned more output than this app can safely review."
                                .to_string(),
                        ));
                    }
                    let final_output =
                        std::fs::read_to_string(&final_output_path).map_err(|_| {
                            ProviderFailure::InvalidResponse(
                                "Codex CLI did not write readable structured translation data."
                                    .to_string(),
                            )
                        })?;
                    let parsed = ai::parse_provider_output(&final_output)
                        .map_err(ProviderFailure::InvalidResponse)?;
                    match output_contract {
                        PromptOutputContract::Exact => {
                            ai::validate_provider_output(&expected, parsed)
                        }
                        PromptOutputContract::Sparse => {
                            ai::validate_provider_output_subset(&expected, parsed)
                        }
                    }
                    .map_err(ProviderFailure::InvalidResponse)
                }
            }
        })();
        let outcome = match &result {
            Ok(_) => "complete",
            Err(ProviderFailure::Cancelled) => "cancelled",
            Err(ProviderFailure::Transient(_)) => "transient_error",
            Err(ProviderFailure::InvalidResponse(_)) => "invalid_response",
            Err(ProviderFailure::Message(_)) => "error",
        };
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        log::info!(
            target: "codex_cli",
            "{}",
            serde_json::json!({
                "event": "attempt_finished",
                "itemCount": item_count,
                "durationMs": duration_ms,
                "outcome": outcome,
                "exitCode": exit_code,
            })
        );
        result
    })
    .await
    .map_err(|_| {
        ProviderFailure::Transient("The Codex CLI worker stopped unexpectedly.".to_string())
    })?
}

#[cfg(test)]
mod review_failure_tests;

#[cfg(test)]
mod merge_followup_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared_item(id: &str, source: &str) -> PreparedAiItem {
        PreparedAiItem {
            id: id.to_string(),
            identity: crate::ai::AiStringIdentity {
                mod_unique_id: "synthetic.test".to_string(),
                relative_dir: "i18n".to_string(),
                key: id.to_string(),
            },
            source: source.to_string(),
            section: Some("Synthetic fixture".to_string()),
            glossary_pairs: Vec::new(),
            context: crate::ai::AiPromptContext::isolated(0),
            default_path: PathBuf::from(r"C:\synthetic\default.json"),
            target_path: PathBuf::from(r"C:\synthetic\de.json"),
            expected_stored: None,
            expected_revision: 0,
        }
    }

    fn provider_translation(id: &str, text: &str) -> ProviderTranslation {
        ProviderTranslation {
            id: id.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn disabled_quality_review_returns_drafts_without_entering_review() {
        let items = vec![prepared_item("item-0000", "Hello, farmer!")];
        let drafts = vec![provider_translation("item-0000", "Hallo!")];
        let cancelled = Arc::new(AtomicBool::new(true));

        let disabled = tauri::async_runtime::block_on(apply_quality_review(
            false,
            None,
            "medium".to_string(),
            "German".to_string(),
            items.clone(),
            drafts.clone(),
            Arc::clone(&cancelled),
            no_progress_callback(),
        ))
        .unwrap();
        assert_eq!(disabled, drafts);

        let enabled = tauri::async_runtime::block_on(apply_quality_review(
            true,
            None,
            "medium".to_string(),
            "German".to_string(),
            items,
            drafts,
            cancelled,
            no_progress_callback(),
        ));
        assert!(matches!(enabled, Err(ProviderFailure::Cancelled)));
    }

    #[test]
    fn disabled_quality_review_skips_final_token_repair() {
        let items = vec![prepared_item("item-0000", "Hello, {{name}}!")];
        let drafts = vec![provider_translation("item-0000", "Hallo!")];

        let outcome = tauri::async_runtime::block_on(repair_token_mismatches_once(
            Some("--invalid-model"),
            "invalid-reasoning",
            "German",
            false,
            &items,
            &drafts,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
        ))
        .unwrap();

        assert_eq!(outcome.translations, drafts);
        assert!(!outcome.cancelled);
    }

    #[test]
    fn status_parser_exposes_only_a_bounded_auth_label() {
        assert_eq!(authentication_label("Logged in using ChatGPT"), "ChatGPT");
        assert_eq!(authentication_label("logged in using API key"), "API key");
        assert_eq!(authentication_label("some future auth"), "CLI managed");
    }

    #[test]
    fn failures_after_executable_resolution_still_report_codex_as_installed() {
        let temp_dir_failure = installed_status_error("temporary directory failed");
        let version_timeout = version_from_status_probe(Ok(ProcessResult::TimedOut)).unwrap_err();
        let version_start_failure =
            version_from_status_probe(Err("process start failed".to_string())).unwrap_err();

        for status in [temp_dir_failure, version_timeout, version_start_failure] {
            assert!(status.installed);
            assert!(!status.authenticated);
            assert_eq!(status.version, None);
            assert_eq!(status.authentication, None);
            assert!(status.error.is_some());
        }
    }

    #[test]
    fn capability_probe_rejects_a_cli_missing_isolation_flags() {
        let supported = "--ask-for-approval --strict-config --config --ephemeral \
            --ignore-user-config --ignore-rules --sandbox --output-schema \
            --output-last-message --json";
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
            Path::new(r"C:\Temp\result.json"),
            Some("gpt-5.6-sol"),
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
        assert!(args.contains(&"--output-last-message".to_string()));
        assert!(args.contains(&"--json".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--model", "gpt-5.6-sol"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn exec_arguments_leave_the_cli_default_untouched_without_a_model() {
        let args = translation_args(
            Path::new(r"C:\Temp\empty"),
            Path::new(r"C:\Temp\schema.json"),
            Path::new(r"C:\Temp\result.json"),
            None,
            "medium",
        );
        assert!(!args.iter().any(|arg| arg == "--model"));
    }

    #[test]
    fn diagnostic_model_labels_reject_paths_and_free_text() {
        assert_eq!(safe_model_for_log(None), "default");
        assert_eq!(safe_model_for_log(Some("gpt-5.6-sol")), "gpt-5.6-sol");
        assert_eq!(safe_model_for_log(Some(r"C:\private\model")), "redacted");
        assert_eq!(safe_model_for_log(Some("private model")), "redacted");
    }

    #[test]
    fn jsonl_progress_parser_forwards_only_safe_activity_and_usage() {
        assert_eq!(
            parse_jsonl_progress(br#"{"type":"thread.started","thread_id":"SECRET"}"#)
                .unwrap()
                .activity,
            Some(ProviderActivity::Starting)
        );
        assert_eq!(
            parse_jsonl_progress(br#"{"type":"turn.started"}"#)
                .unwrap()
                .activity,
            Some(ProviderActivity::Working)
        );
        assert_eq!(
            parse_jsonl_progress(
                br#"{"type":"item.updated","item":{"type":"reasoning","text":"SECRET_SOURCE","path":"C:\\private"}}"#,
            )
            .unwrap()
            .activity,
            Some(ProviderActivity::Reasoning)
        );
        assert_eq!(
            parse_jsonl_progress(
                br#"{"type":"item.completed","item":{"type":"agent_message","text":"SECRET_TRANSLATION"}}"#,
            )
            .unwrap()
            .activity,
            Some(ProviderActivity::WritingResponse)
        );
        let completed = parse_jsonl_progress(
            concat!(
                "{\"type\":\"turn.completed\",\"usage\":{",
                "\"input_tokens\":14354,\"cached_input_tokens\":12000,",
                "\"cache_write_input_tokens\":0,\"output_tokens\":52,",
                "\"reasoning_output_tokens\":31}}"
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(completed.activity, Some(ProviderActivity::Completed));
        assert_eq!(
            completed.usage,
            Some(ProviderTokenUsage {
                input_tokens: 14_354,
                cached_input_tokens: 12_000,
                output_tokens: 52,
                reasoning_output_tokens: 31,
            })
        );
        assert_eq!(
            parse_jsonl_progress(br#"{"type":"turn.failed","error":"SECRET_ERROR"}"#)
                .unwrap()
                .activity,
            Some(ProviderActivity::Failed)
        );
        assert_eq!(
            parse_jsonl_progress(br#"{"type":"error","message":"SECRET_ERROR"}"#)
                .unwrap()
                .activity,
            Some(ProviderActivity::Failed)
        );
        assert!(parse_jsonl_progress(br#"{"type":"future.event","value":1}"#).is_none());
        assert!(parse_jsonl_progress(b"not jsonl").is_none());
        assert!(!format!("{completed:?}").contains("SECRET"));
    }

    #[test]
    fn app_server_reads_do_not_reject_newer_codex_config_fields() {
        let args = app_server_args();
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(args, ["app-server", "--stdio"]);
        assert!(!args.contains(&"--strict-config".to_string()));
    }

    #[test]
    fn rate_limits_request_uses_the_documented_parameterless_shape() {
        let request: Value = serde_json::from_str(&rate_limits_request()).unwrap();
        assert_eq!(request["method"], "account/rateLimits/read");
        assert_eq!(request["id"], 2);
        assert!(request.get("params").is_none());
    }

    #[test]
    fn rate_limits_parser_prefers_the_current_codex_bucket() {
        let parsed = parse_rate_limits_response(
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":15,"resetsAt":1730947200}},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1730947200},"secondary":{"usedPercent":42.5,"windowDurationMins":10080,"resetsAt":1731552000},"futureField":true},"codex_other":{"primary":{"usedPercent":99}}},"rateLimitResetCredits":{"availableCount":2}}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed.primary.as_ref().unwrap().used_percent, 25.0);
        assert_eq!(
            parsed.primary.as_ref().unwrap().window_duration_mins,
            Some(300)
        );
        assert_eq!(parsed.secondary.as_ref().unwrap().used_percent, 42.5);
        assert_eq!(
            parsed.secondary.as_ref().unwrap().window_duration_mins,
            Some(10_080)
        );
    }

    #[test]
    fn rate_limits_parser_accepts_the_legacy_single_bucket_shape() {
        let parsed = parse_rate_limits_response(
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":6,"windowDurationMins":60,"resetsAt":1730947200}},"rateLimitsByLimitId":null}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed.primary.unwrap().used_percent, 6.0);
        assert!(parsed.secondary.is_none());
    }

    #[test]
    fn rate_limits_parser_tolerates_missing_windows_and_sanitizes_time() {
        let missing = parse_rate_limits_response(
            r#"{"id":2,"result":{"rateLimits":{"primary":null,"secondary":null}}}"#,
        )
        .unwrap();
        assert!(missing.is_none());

        let parsed = parse_rate_limits_response(
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":101,"windowDurationMins":5,"resetsAt":10},"secondary":{"usedPercent":25,"windowDurationMins":-1,"resetsAt":-2}}}}"#,
        )
        .unwrap()
        .unwrap();
        assert!(parsed.primary.is_none());
        let secondary = parsed.secondary.unwrap();
        assert_eq!(secondary.used_percent, 25.0);
        assert!(secondary.window_duration_mins.is_none());
        assert!(secondary.resets_at.is_none());
    }

    #[test]
    fn rate_limits_parser_treats_unsupported_auth_and_old_cli_as_unavailable() {
        for response in [
            r#"{"id":2,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}"#,
            r#"{"id":2,"error":{"code":-32601,"message":"future wording"}}"#,
        ] {
            assert!(parse_rate_limits_response(response).unwrap().is_none());
        }
    }

    #[test]
    fn rate_limits_parser_never_surfaces_raw_server_errors() {
        let error = parse_rate_limits_response(
            r#"{"id":2,"error":{"code":500,"message":"private account detail"}}"#,
        )
        .unwrap_err();
        assert_eq!(error, "Codex CLI could not read ChatGPT usage limits.");
        assert!(!error.contains("private"));
    }

    #[test]
    fn model_list_parser_accepts_the_documented_catalog_shape() {
        let parsed = parse_model_list_response(
            r#"{"id":2,"result":{"data":[{"model":"gpt-5.6-sol","displayName":"GPT-5.6-Sol","hidden":false,"isDefault":true,"defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast"}]}],"nextCursor":null}}"#,
        )
        .unwrap();
        assert_eq!(parsed.data.len(), 1);
        assert_eq!(parsed.data[0].model, "gpt-5.6-sol");
        assert!(parsed.data[0].is_default);
        assert_eq!(
            parsed.data[0].supported_reasoning_efforts[0].reasoning_effort,
            "low"
        );
        assert!(parsed.next_cursor.is_none());
    }

    #[test]
    fn model_list_parser_surfaces_a_bounded_server_error() {
        let message = "x".repeat(300);
        let body = serde_json::json!({
            "id": 2,
            "error": { "message": message }
        })
        .to_string();
        let error = parse_model_list_response(&body).unwrap_err();
        assert!(error.starts_with("Codex CLI could not list models: "));
        assert!(error.chars().count() < 220);
    }

    #[test]
    fn failed_exit_separates_authentication_from_transient_process_failures() {
        assert!(matches!(
            failed_exit(Some(1), "", "Not logged in"),
            ProviderFailure::Message(message) if message.contains("not signed in")
        ));
        assert!(matches!(
            failed_exit(Some(17), "", "temporary service failure"),
            ProviderFailure::Transient(message) if message.contains("17")
        ));
    }

    #[test]
    fn structural_retry_prompt_uses_only_a_bounded_validator_hint() {
        let item = prepared_item("item-0000", "Hello");
        let validator_error = format!("{} SHOULD_NOT_SURVIVE", "🦀".repeat(300));
        let prompt =
            build_translation_attempt_prompt("German", &[item], Some(&validator_error)).unwrap();

        assert!(prompt.instructions.contains("structure-correction attempt"));
        assert!(!prompt.instructions.contains("SHOULD_NOT_SURVIVE"));
        assert_eq!(
            bounded_structural_hint(&validator_error).chars().count(),
            MAX_STRUCTURAL_HINT_CHARS
        );
        assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
    }

    #[test]
    fn initial_chunks_reserve_the_complete_utf8_structure_retry_prompt() {
        let source = "x".repeat(47 * 1024);
        let items = vec![
            prepared_item("item-0000", &source),
            prepared_item("item-0001", &source),
        ];
        let unreserved = ai::build_provider_prompt("German", &items).unwrap();
        assert!(unreserved.input.len() <= ai::MAX_CHUNK_BYTES);
        assert!(matches!(
            build_translation_attempt_prompt(
                "German",
                &items,
                Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
            ),
            Err(ProviderFailure::InvalidResponse(_))
        ));

        let chunks = ai::chunks(&items).unwrap();
        assert_eq!(chunks.len(), 2);
        for chunk in chunks {
            let prompt = build_translation_attempt_prompt(
                "German",
                chunk,
                Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
            )
            .unwrap();
            assert!(
                complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES
            );
        }
    }

    #[test]
    fn transient_and_structural_retry_budgets_are_independent_and_bounded() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut scripted = std::collections::VecDeque::from([
            Err(ProviderFailure::Transient("temporary".to_string())),
            Err(ProviderFailure::InvalidResponse("wrong ids".to_string())),
            Ok(vec![provider_translation("item-0000", "Hallo")]),
        ]);
        let mut corrections = Vec::new();
        let mut progress = Vec::new();

        let result = tauri::async_runtime::block_on(translate_chunk_with_recovery_reporting(
            cancelled,
            |correction| {
                corrections.push(correction);
                std::future::ready(scripted.pop_front().expect("bounded attempt"))
            },
            |event| progress.push(event),
        ))
        .unwrap();

        assert_eq!(result[0].text, "Hallo");
        assert_eq!(corrections, vec![None, None, Some("wrong ids".to_string())]);
        assert_eq!(
            progress,
            [
                ProviderProgressEvent::TransientRetry,
                ProviderProgressEvent::StructureRetry
            ]
        );
        assert!(scripted.is_empty());
    }

    #[test]
    fn repeated_same_class_failure_stops_after_its_single_retry() {
        for scripted in [
            std::collections::VecDeque::from([
                Err(ProviderFailure::Transient("first".to_string())),
                Err(ProviderFailure::Transient("second".to_string())),
            ]),
            std::collections::VecDeque::from([
                Err(ProviderFailure::InvalidResponse("first".to_string())),
                Err(ProviderFailure::InvalidResponse("second".to_string())),
            ]),
        ] {
            let cancelled = Arc::new(AtomicBool::new(false));
            let mut scripted = scripted;
            let mut attempts = 0usize;
            let result =
                tauri::async_runtime::block_on(translate_chunk_with_recovery(cancelled, |_| {
                    attempts += 1;
                    std::future::ready(scripted.pop_front().expect("bounded attempt"))
                }));
            assert!(result.is_err());
            assert_eq!(attempts, 2);
            assert!(scripted.is_empty());
        }
    }

    #[test]
    fn cancellation_wins_before_a_scheduled_retry() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_from_attempt = Arc::clone(&cancelled);
        let mut attempts = 0usize;
        let result =
            tauri::async_runtime::block_on(translate_chunk_with_recovery(cancelled, |_| {
                attempts += 1;
                cancel_from_attempt.store(true, Ordering::Release);
                std::future::ready(Err(ProviderFailure::Transient("temporary".to_string())))
            }));

        assert_eq!(result, Err(ProviderFailure::Cancelled));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn full_review_prompt_covers_every_quality_dimension_and_reuses_all_context() {
        let mut item = prepared_item("item-0000", "Parsnip soup for you, {{name}}.");
        item.section = Some("Abigail dialogue".to_string());
        item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        item.context.before.push(crate::ai::AiContextSource {
            source: "I made this myself.".to_string(),
        });
        item.context.after.push(crate::ai::AiContextSource {
            source: "Do you like it?".to_string(),
        });
        let draft = provider_translation("item-0000", "Rübensuppe für dich, {{name}}.");

        let prompt = build_review_attempt_prompt(
            "German",
            std::slice::from_ref(&item),
            std::slice::from_ref(&draft),
            Some("wrong ids"),
        )
        .unwrap();

        for required in [
            "natural language",
            "accurate meaning",
            "terminology",
            "grammar",
            "register",
            "implied speaker voice",
            "dialogue continuity",
        ] {
            assert!(prompt.instructions.contains(required), "missing {required}");
        }
        assert!(prompt.instructions.contains("every supplied draft"));
        assert!(prompt.instructions.contains("not a glossary-only check"));
        assert!(prompt.instructions.contains("omit unchanged ids"));
        assert!(prompt.instructions.contains("empty `translations` array"));
        assert!(prompt.instructions.contains("structure-correction attempt"));
        assert_eq!(prompt.schema["properties"]["translations"]["minItems"], 0);
        assert_eq!(prompt.schema["properties"]["translations"]["maxItems"], 1);
        let input: serde_json::Value = serde_json::from_str(&prompt.input).unwrap();
        let reviewed = &input["strings"][0];
        assert_eq!(reviewed["source"], item.source);
        assert_eq!(reviewed["draft"], draft.text);
        assert_eq!(reviewed["section"], "Abigail dialogue");
        assert_eq!(reviewed["glossary"][0]["target"], "Pastinake");
        let context_sources = input["contextSources"].as_array().unwrap();
        let before = reviewed["context"]["before"][0].as_u64().unwrap() as usize;
        let after = reviewed["context"]["after"][0].as_u64().unwrap() as usize;
        assert_eq!(context_sources[before], "I made this myself.");
        assert_eq!(context_sources[after], "Do you like it?");
        assert!(complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES);
    }

    #[test]
    fn review_plans_keep_context_groups_together_and_bound_retry_prompts() {
        let mut first = prepared_item("item-0000", "First");
        first.context = crate::ai::AiPromptContext::isolated(0);
        let mut second = prepared_item("item-0001", "Second");
        second.context = crate::ai::AiPromptContext::isolated(0);
        let mut third = prepared_item("item-0002", "Third");
        third.context = crate::ai::AiPromptContext::isolated(1);
        let items = vec![first, second, third];
        let drafts = vec![
            provider_translation("item-0000", &"a".repeat(15 * 1024)),
            provider_translation("item-0001", &"b".repeat(15 * 1024)),
            provider_translation("item-0002", &"c".repeat(65 * 1024)),
        ];

        let plans = build_review_plans("German", &items, &drafts).unwrap();
        let scheduled = plans
            .iter()
            .flat_map(|plan| plan.items.iter().map(|item| item.id.clone()))
            .collect::<Vec<_>>();

        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].items.len(), 2);
        assert_eq!(plans[1].items.len(), 1);
        assert_eq!(scheduled, vec!["item-0000", "item-0001", "item-0002"]);
        for plan in &plans {
            let prompt = build_review_attempt_prompt(
                "German",
                &plan.items,
                &plan.drafts,
                Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
            )
            .unwrap();
            assert!(
                complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES
            );
        }
        assert_eq!(plans[0].drafts, drafts[..2]);
        assert_eq!(plans[1].drafts, drafts[2..]);
    }

    #[test]
    fn review_fit_trims_only_context_and_rejects_oversized_source_or_draft() {
        let mut item = prepared_item("item-0000", "Keep this source byte-for-byte.");
        item.context.before.push(crate::ai::AiContextSource {
            source: "b".repeat(ai::MAX_CHUNK_BYTES / 2),
        });
        item.context.after.push(crate::ai::AiContextSource {
            source: "a".repeat(ai::MAX_CHUNK_BYTES / 3),
        });
        let draft_text = "d".repeat(ai::MAX_CHUNK_BYTES / 3);
        let draft = provider_translation("item-0000", &draft_text);

        let plans = build_review_plans(
            "German",
            std::slice::from_ref(&item),
            std::slice::from_ref(&draft),
        )
        .unwrap();

        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].items[0].source, item.source);
        assert_eq!(plans[0].drafts[0].text, draft_text);
        assert!(plans[0].items[0].context.before.is_empty());
        assert_eq!(plans[0].items[0].context.after.len(), 1);

        let oversized_item = prepared_item("item-0001", "Source must not be trimmed");
        let oversized_draft = provider_translation("item-0001", &"x".repeat(ai::MAX_CHUNK_BYTES));
        assert!(matches!(
            build_review_plans(
                "German",
                std::slice::from_ref(&oversized_item),
                std::slice::from_ref(&oversized_draft),
            ),
            Err(ProviderFailure::InvalidResponse(_))
        ));
    }

    #[test]
    fn persistent_review_failure_keeps_drafts_and_cancellation_propagates() {
        let items = vec![prepared_item("item-0000", "Hello")];
        let drafts = vec![provider_translation("item-0000", "Hallo")];
        let plans = build_review_plans("German", &items, &drafts).unwrap();
        let mut attempts = 0usize;
        let failed = tauri::async_runtime::block_on(execute_review_plans(
            &items,
            &drafts,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _, _| {
                attempts += 1;
                std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                    ProviderFailure::InvalidResponse("wrong ids".to_string()),
                ))
            },
        ));

        assert_eq!(failed, Ok(drafts.clone()));
        assert_eq!(attempts, 2);

        let cancelled = Arc::new(AtomicBool::new(true));
        let mut cancelled_calls = 0usize;
        let cancellation = tauri::async_runtime::block_on(execute_review_plans(
            &items,
            &drafts,
            build_review_plans("German", &items, &drafts).unwrap(),
            cancelled,
            no_progress_callback(),
            |_, _, _| {
                cancelled_calls += 1;
                std::future::ready(Ok(Vec::new()))
            },
        ));
        assert_eq!(cancellation, Err(ProviderFailure::Cancelled));
        assert_eq!(cancelled_calls, 0);
    }

    #[test]
    fn sparse_review_merges_changes_by_identity_and_retains_omitted_drafts() {
        let mut first = prepared_item("item-0000", "First");
        first.context = crate::ai::AiPromptContext::isolated(0);
        let mut second = prepared_item("item-0001", "Second");
        second.context = crate::ai::AiPromptContext::isolated(0);
        let mut third = prepared_item("item-0002", "Third");
        third.context = crate::ai::AiPromptContext::isolated(0);
        let items = vec![first, second, third];
        let drafts = vec![
            provider_translation("item-0000", "Erster Entwurf"),
            provider_translation("item-0001", "Zweiter Entwurf"),
            provider_translation("item-0002", "Dritter Entwurf"),
        ];
        let plans = build_review_plans("German", &items, &drafts).unwrap();
        let mut calls = 0usize;

        let reviewed = tauri::async_runtime::block_on(execute_review_plans(
            &items,
            &drafts,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _, _| {
                calls += 1;
                std::future::ready(Ok(vec![provider_translation(
                    "item-0001",
                    "Korrigierter zweiter Entwurf",
                )]))
            },
        ))
        .unwrap();

        assert_eq!(calls, 1);
        assert_eq!(reviewed[0], drafts[0]);
        assert_eq!(reviewed[1].text, "Korrigierter zweiter Entwurf");
        assert_eq!(reviewed[2], drafts[2]);
    }

    #[test]
    fn empty_sparse_review_keeps_every_draft_without_retry() {
        let items = vec![prepared_item("item-0000", "Hello")];
        let drafts = vec![provider_translation("item-0000", "Hallo")];
        let plans = build_review_plans("German", &items, &drafts).unwrap();
        let mut calls = 0usize;

        let reviewed = tauri::async_runtime::block_on(execute_review_plans(
            &items,
            &drafts,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _, _| {
                calls += 1;
                std::future::ready(Ok(Vec::new()))
            },
        ))
        .unwrap();

        assert_eq!(calls, 1);
        assert_eq!(reviewed, drafts);
    }

    #[test]
    fn review_token_damage_is_rejected_and_keeps_the_draft() {
        let items = vec![prepared_item("item-0000", "Hello, {{name}}.")];
        let drafts = vec![provider_translation("item-0000", "Hallo, {{name}}.")];
        let plans = build_review_plans("German", &items, &drafts).unwrap();

        let reviewed = tauri::async_runtime::block_on(execute_review_plans(
            &items,
            &drafts,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _, _| {
                std::future::ready(Ok(vec![provider_translation(
                    "item-0000",
                    "Eine natürlichere Begrüßung.",
                )]))
            },
        ))
        .unwrap();

        assert_eq!(reviewed, drafts);
        assert!(build_token_repair_plans("German", &items, &reviewed)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn full_review_runs_without_glossary_and_schedules_no_terminology_repair() {
        let items = vec![prepared_item("item-0000", "This sounds awkward.")];
        let drafts = vec![provider_translation("item-0000", "Dies klingt unbeholfen.")];
        let plans = build_review_plans("German", &items, &drafts).unwrap();
        let mut review_calls = 0usize;

        let reviewed = tauri::async_runtime::block_on(execute_review_plans(
            &items,
            &drafts,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |review_items, _, _| {
                review_calls += 1;
                std::future::ready(Ok(vec![provider_translation(
                    &review_items[0].id,
                    "Das klingt unnatürlich.",
                )]))
            },
        ))
        .unwrap();
        let terminology = build_terminology_repair_plans("German", &items, &reviewed).unwrap();

        assert_eq!(review_calls, 1);
        assert_eq!(reviewed[0].text, "Das klingt unnatürlich.");
        assert!(terminology.is_empty());
    }

    #[test]
    fn terminology_prompt_is_conservative_exact_and_bounded() {
        let mut item = prepared_item("item-0000", "A parsnip is ready.");
        item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        let items = vec![item.clone()];
        let translations = vec![provider_translation("item-0000", "Eine Rübe ist fertig.")];

        assert_eq!(
            conservative_glossary_candidates(&item, &translations[0].text),
            item.glossary_pairs
        );
        assert!(conservative_glossary_candidates(&item, "Pastinakenernte ist fertig.").is_empty());

        let mut plans = build_terminology_repair_plans("German", &items, &translations).unwrap();
        assert_eq!(plans.len(), 1);
        let plan = plans.pop().unwrap();
        let prompt = build_terminology_repair_attempt_prompt(
            "German",
            &plan.items,
            &plan.translations,
            &plan.findings,
            None,
        )
        .unwrap();
        let input: serde_json::Value = serde_json::from_str(&prompt.input).unwrap();
        let strings = input["strings"].as_array().unwrap();
        let lower_instructions = prompt.instructions.to_ascii_lowercase();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].id, "item-0000");
        assert_eq!(strings.len(), 1);
        assert_eq!(strings[0]["terminologyFindings"][0]["source"], "Parsnip");
        assert_eq!(strings[0]["terminologyFindings"][0]["target"], "Pastinake");
        assert!(strings[0].get("glossary").is_none());
        assert_eq!(
            strings[0]["terminologyFindings"][0]["kind"],
            "glossaryTargetNotDetected"
        );
        assert!(lower_instructions.contains("conservative candidates"));
        assert!(!lower_instructions.contains("official"));
        assert!(!lower_instructions.contains("high-confidence"));
        assert!(prompt.instructions.contains("returned unchanged"));
        assert!(prompt
            .instructions
            .contains("Do not add, remove, reorder, translate, or alter those tokens."));
        assert!(prompt
            .instructions
            .contains("Gender-switch blocks `${...}$` contain translatable branch prose."));
        assert!(prompt
            .instructions
            .contains("Preserve every existing quote character EXACTLY."));
        assert!(prompt.instructions.contains("Keep the same line breaks."));
        let correction = build_terminology_repair_attempt_prompt(
            "German",
            &plan.items,
            &plan.translations,
            &plan.findings,
            Some("wrong ids"),
        )
        .unwrap();
        assert!(correction
            .instructions
            .contains("structure-correction attempt"));
        assert!(correction
            .instructions
            .contains("single focused terminology-repair phase"));
        assert_eq!(correction.input, prompt.input);
        assert!(
            complete_prompt_bytes(&correction.instructions, &correction.input)
                <= ai::MAX_CHUNK_BYTES
        );
    }

    #[test]
    fn terminology_plans_split_and_bound_retry_prompts() {
        let mut items = vec![
            prepared_item("item-0000", "Parsnip one"),
            prepared_item("item-0001", "Parsnip two"),
            prepared_item("item-0002", "Parsnip three"),
        ];
        for item in &mut items {
            item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        }
        let large = "x".repeat(ai::MAX_CHUNK_BYTES / 3);
        let translations = items
            .iter()
            .map(|item| provider_translation(&item.id, &large))
            .collect::<Vec<_>>();

        let plans = build_terminology_repair_plans("German", &items, &translations).unwrap();
        let scheduled = plans
            .iter()
            .flat_map(|plan| plan.items.iter().map(|item| item.id.clone()))
            .collect::<Vec<_>>();

        assert!(plans.len() >= 2);
        assert_eq!(scheduled, vec!["item-0000", "item-0001", "item-0002"]);
        for plan in &plans {
            let prompt = build_terminology_repair_attempt_prompt(
                "German",
                &plan.items,
                &plan.translations,
                &plan.findings,
                Some(&"🦀".repeat(MAX_STRUCTURAL_HINT_CHARS)),
            )
            .unwrap();
            assert!(
                complete_prompt_bytes(&prompt.instructions, &prompt.input) <= ai::MAX_CHUNK_BYTES
            );
        }
    }

    #[test]
    fn terminology_repair_has_independent_bounded_transient_and_structure_retries() {
        let mut item = prepared_item("item-0000", "Parsnip");
        item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        let items = vec![item];
        let reviewed = vec![provider_translation("item-0000", "Rübe")];
        let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
        let mut scripted = std::collections::VecDeque::from([
            Err(ProviderFailure::Transient("temporary".to_string())),
            Err(ProviderFailure::InvalidResponse("wrong ids".to_string())),
            Ok(vec![provider_translation("item-0000", "Pastinake")]),
        ]);
        let mut corrections = Vec::new();

        let outcome = tauri::async_runtime::block_on(execute_terminology_repair_plans(
            &items,
            &reviewed,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _, _, structural_error| {
                corrections.push(structural_error);
                std::future::ready(scripted.pop_front().expect("bounded attempt"))
            },
        ))
        .unwrap();

        assert_eq!(outcome[0].text, "Pastinake");
        assert_eq!(corrections, vec![None, None, Some("wrong ids".to_string())]);
        assert!(scripted.is_empty());
    }

    #[test]
    fn persistent_invalid_terminology_repair_is_bisected_without_resending_successes() {
        let mut items = vec![
            prepared_item("item-0000", "Parsnip one"),
            prepared_item("item-0001", "Parsnip two"),
        ];
        for item in &mut items {
            item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        }
        let reviewed = vec![
            provider_translation("item-0000", "Rübe eins"),
            provider_translation("item-0001", "Rübe zwei"),
        ];
        let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
        assert_eq!(plans.len(), 1);
        let mut calls = Vec::new();

        let outcome = tauri::async_runtime::block_on(execute_terminology_repair_plans(
            &items,
            &reviewed,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |repair_items, _, _, _| {
                let ids = repair_items
                    .iter()
                    .map(|item| item.id.clone())
                    .collect::<Vec<_>>();
                calls.push(ids.clone());
                let result = if ids.len() > 1 || ids[0] == "item-0000" {
                    Err(ProviderFailure::InvalidResponse("wrong ids".to_string()))
                } else {
                    Ok(vec![provider_translation("item-0001", "Pastinake zwei")])
                };
                std::future::ready(result)
            },
        ))
        .unwrap();

        assert_eq!(calls.len(), 5);
        assert_eq!(
            calls
                .iter()
                .filter(|ids| ids.as_slice() == ["item-0001".to_string()])
                .count(),
            1
        );
        assert_eq!(outcome[0], reviewed[0]);
        assert_eq!(outcome[1].text, "Pastinake zwei");

        let cancellation = tauri::async_runtime::block_on(execute_terminology_repair_plans(
            &items,
            &reviewed,
            build_terminology_repair_plans("German", &items, &reviewed).unwrap(),
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _, _, _| {
                std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                    ProviderFailure::Cancelled,
                ))
            },
        ));
        assert_eq!(cancellation, Err(ProviderFailure::Cancelled));
    }

    #[test]
    fn existing_token_damage_reaches_failed_final_repair_as_blocking_diff() {
        let mut item = prepared_item("item-0000", "Parsnip for {{name}}");
        item.glossary_pairs = vec![("Parsnip".to_string(), "Pastinake".to_string())];
        let items = vec![item];
        // The reviewed draft already lacks {{name}}, so the terminology fix adds
        // no new mismatch and is accepted; the old damage still needs repair.
        let reviewed = vec![provider_translation("item-0000", "Rübe für dich")];
        let plans = build_terminology_repair_plans("German", &items, &reviewed).unwrap();
        let mut calls = 0usize;

        let terminology = tauri::async_runtime::block_on(execute_terminology_repair_plans(
            &items,
            &reviewed,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |expected, _, _, _| {
                calls += 1;
                std::future::ready(Ok(vec![provider_translation(
                    &expected[0].id,
                    "Pastinake für dich",
                )]))
            },
        ))
        .unwrap();

        assert_eq!(calls, 1);
        assert_eq!(terminology[0].text, "Pastinake für dich");

        let token_plans = build_token_repair_plans("German", &items, &terminology).unwrap();
        assert_eq!(token_plans.len(), 1);
        let token_outcome = tauri::async_runtime::block_on(execute_token_repair_plans(
            &items,
            &terminology,
            token_plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, _| {
                std::future::ready(Err::<Vec<ProviderTranslation>, _>(
                    ProviderFailure::Transient("temporary".to_string()),
                ))
            },
        ))
        .unwrap();
        assert!(!token_outcome.cancelled);
        assert_eq!(token_outcome.translations, terminology);
        let suggestions = ai::suggestions(&items, token_outcome.translations).unwrap();
        assert!(!suggestions[0].token_differences.is_empty());
    }

    #[test]
    fn token_repair_plan_contains_only_affected_ids_and_concrete_counts() {
        let items = vec![
            prepared_item("item-0000", "Hello {{name}}"),
            prepared_item("item-0001", "Plain source"),
        ];
        let translations = vec![
            provider_translation("item-0000", "Hallo {{other}}"),
            provider_translation("item-0001", "Einfacher Text"),
        ];

        let mut plans = build_token_repair_plans("German", &items, &translations).unwrap();
        assert_eq!(plans.len(), 1);
        let plan = plans.pop().unwrap();
        let input: serde_json::Value = serde_json::from_str(&plan.prompt.input).unwrap();
        let strings = input["strings"].as_array().unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].id, "item-0000");
        assert_eq!(strings.len(), 1);
        assert_eq!(strings[0]["id"], "item-0000");
        assert_eq!(strings[0]["source"], "Hello {{name}}");
        assert_eq!(strings[0]["translation"], "Hallo {{other}}");
        assert_eq!(strings[0]["tokenDifferences"].as_array().unwrap().len(), 2);
        assert!(plan
            .prompt
            .instructions
            .contains("gender-switch shape descriptors, not literal empty text"));
        assert_eq!(
            plan.prompt.schema["properties"]["translations"]["minItems"],
            1
        );
        assert!(!plan.prompt.input.contains("Plain source"));
        assert!(
            complete_prompt_bytes(&plan.prompt.instructions, &plan.prompt.input)
                <= ai::MAX_CHUNK_BYTES
        );
    }

    #[test]
    fn token_repair_plans_split_by_serialized_size_and_schedule_each_item_once() {
        let items = vec![
            prepared_item("item-0000", "Hello {{name}}"),
            prepared_item("item-0001", "Hello {{name}}"),
            prepared_item("item-0002", "Hello {{name}}"),
        ];
        let large = "x".repeat(ai::MAX_CHUNK_BYTES / 2);
        let translations = vec![
            provider_translation("item-0000", &large),
            provider_translation("item-0001", &large),
            provider_translation("item-0002", "Kurz"),
        ];

        let plans = build_token_repair_plans("German", &items, &translations).unwrap();
        let scheduled = plans
            .iter()
            .flat_map(|plan| plan.items.iter().map(|item| item.id.as_str()))
            .collect::<Vec<_>>();

        assert!(plans.len() >= 2);
        assert!(plans.iter().all(|plan| complete_prompt_bytes(
            &plan.prompt.instructions,
            &plan.prompt.input
        ) <= ai::MAX_CHUNK_BYTES));
        assert_eq!(scheduled, vec!["item-0000", "item-0001", "item-0002"]);
    }

    #[test]
    fn token_repair_merge_replaces_only_fully_valid_repairs() {
        let items = vec![
            prepared_item("item-0000", "Hello {{name}}"),
            prepared_item("item-0001", "Count {0}"),
        ];
        let originals = vec![
            provider_translation("item-0000", "Hallo"),
            provider_translation("item-0001", "Anzahl"),
        ];
        let repairs = vec![
            provider_translation("item-0000", "Hallo {{name}}"),
            provider_translation("item-0001", "Noch immer ohne Token"),
        ];

        let merged = merge_valid_token_repairs(&items, &originals, &items, repairs);

        assert_eq!(merged[0].text, "Hallo {{name}}");
        assert_eq!(merged[1].text, "Anzahl");
    }

    #[test]
    fn individually_oversized_token_repair_is_skipped_and_keeps_its_original() {
        let items = vec![prepared_item("item-0000", "Hello {{name}}")];
        let instructions = token_repair_instructions("German");
        let translation =
            "x".repeat(ai::MAX_CHUNK_BYTES - instructions.len() - PROMPT_INPUT_SEPARATOR.len());
        let translations = vec![provider_translation("item-0000", &translation)];
        let differences = crate::tokens::token_differences(&items[0].source, &translation);
        let input = serialize_token_repair_input(&[serde_json::json!({
            "id": items[0].id,
            "source": items[0].source,
            "translation": translation,
            "tokenDifferences": differences.iter().map(|difference| serde_json::json!({
                "token": difference.token,
                "sourceCount": difference.source_count,
                "targetCount": difference.target_count,
            })).collect::<Vec<_>>(),
        })])
        .unwrap();

        assert!(input.len() <= ai::MAX_CHUNK_BYTES);
        assert!(complete_prompt_bytes(&instructions, &input) > ai::MAX_CHUNK_BYTES);

        let plans = build_token_repair_plans("German", &items, &translations).unwrap();

        assert!(plans.is_empty());
    }

    #[test]
    fn failed_token_repair_sub_batch_keeps_its_original_and_later_plans_continue() {
        let items = vec![
            prepared_item("item-0000", "Hello {{name}}"),
            prepared_item("item-0001", "Hello {{name}}"),
        ];
        let large = "x".repeat(ai::MAX_CHUNK_BYTES / 2);
        let originals = vec![
            provider_translation("item-0000", &large),
            provider_translation("item-0001", &large),
        ];
        let plans = build_token_repair_plans("German", &items, &originals).unwrap();
        assert_eq!(plans.len(), 2);
        let mut calls = 0usize;

        let outcome = tauri::async_runtime::block_on(execute_token_repair_plans(
            &items,
            &originals,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, expected| {
                calls += 1;
                let result = if calls == 1 {
                    Err(ProviderFailure::Transient("temporary".to_string()))
                } else {
                    Ok(expected
                        .iter()
                        .map(|item| provider_translation(&item.id, "Repaired {{name}}"))
                        .collect())
                };
                std::future::ready(result)
            },
        ))
        .unwrap();

        assert_eq!(calls, 2);
        assert!(!outcome.cancelled);
        assert_eq!(outcome.translations[0].text, large);
        assert_eq!(outcome.translations[1].text, "Repaired {{name}}");
    }

    #[test]
    fn cancellation_returns_repairs_completed_by_earlier_sub_batches() {
        let items = vec![
            prepared_item("item-0000", "Hello {{name}}"),
            prepared_item("item-0001", "Hello {{name}}"),
        ];
        let large = "x".repeat(ai::MAX_CHUNK_BYTES / 2);
        let originals = vec![
            provider_translation("item-0000", &large),
            provider_translation("item-0001", &large),
        ];
        let plans = build_token_repair_plans("German", &items, &originals).unwrap();
        let mut calls = 0usize;

        let outcome = tauri::async_runtime::block_on(execute_token_repair_plans(
            &items,
            &originals,
            plans,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
            |_, expected| {
                calls += 1;
                let result = if calls == 1 {
                    Ok(expected
                        .iter()
                        .map(|item| provider_translation(&item.id, "Repaired {{name}}"))
                        .collect())
                } else {
                    Err(ProviderFailure::Cancelled)
                };
                std::future::ready(result)
            },
        ))
        .unwrap();

        assert_eq!(calls, 2);
        assert!(outcome.cancelled);
        assert_eq!(outcome.translations[0].text, "Repaired {{name}}");
        assert_eq!(outcome.translations[1].text, large);
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
            ProcessOptions {
                working_dir: &temp.path,
                timeout,
                cancelled,
                output_limits,
                stdout_line: None,
            },
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
            "jsonl-near-final-limit" => {
                let body = vec![b'x'; MAX_FINAL_OUTPUT_BYTES as usize * 2];
                std::io::stdout().write_all(&body).unwrap();
                std::io::stdout().flush().unwrap();
            }
            "jsonl-overflow" => {
                let body = vec![b'x'; MAX_TRANSLATION_JSONL_BYTES as usize + 1];
                std::io::stdout().write_all(&body).unwrap();
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            "jsonl-stream" => {
                std::io::stdout()
                    .write_all(b"\n{\"type\":\"thread.started\",\"thread_id\":\"SECRET\"}\n")
                    .unwrap();
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_millis(400));
                std::io::stdout()
                    .write_all(
                        concat!(
                            "{\"type\":\"item.updated\",\"item\":{\"type\":\"reasoning\",",
                            "\"text\":\"SECRET_SOURCE\"}}\n",
                            "{\"type\":\"turn.completed\",\"usage\":{",
                            "\"input_tokens\":100,\"cached_input_tokens\":80,",
                            "\"output_tokens\":20,\"reasoning_output_tokens\":10}}\n"
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                std::io::stdout().flush().unwrap();
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
    fn direct_runner_reports_safe_jsonl_activity_before_process_exit() {
        let temp = TempRunDir::create("fake-codex-jsonl-stream").unwrap();
        std::fs::write(temp.path.join("fake-mode.txt"), "jsonl-stream").unwrap();
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let args = fake_runner_args();
        let working_dir = temp.path.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let runner_cancelled = Arc::clone(&cancelled);
        let (sender, receiver) = std::sync::mpsc::channel();
        let stdout_line: ProcessLineCallback = Arc::new(move |line| {
            if let Some(progress) = parse_jsonl_progress(line) {
                let _ = sender.send(progress);
            }
        });
        let runner = std::thread::spawn(move || {
            run_command(
                &executable,
                &args,
                None,
                ProcessOptions {
                    working_dir: &working_dir,
                    timeout: Duration::from_secs(10),
                    cancelled: &runner_cancelled,
                    output_limits: TRANSLATION_OUTPUT_LIMITS,
                    stdout_line: Some(stdout_line),
                },
            )
            .unwrap()
        });

        let first = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first.activity, Some(ProviderActivity::Starting));
        assert!(!runner.is_finished());

        assert!(matches!(
            runner.join().unwrap(),
            ProcessResult::Finished { success: true, .. }
        ));
        let remaining = receiver.try_iter().collect::<Vec<_>>();
        assert!(remaining
            .iter()
            .any(|event| event.activity == Some(ProviderActivity::Reasoning)));
        assert!(remaining
            .iter()
            .any(|event| event.activity == Some(ProviderActivity::Completed)));
        assert_eq!(
            remaining
                .iter()
                .filter(|event| event.usage.is_some())
                .count(),
            1
        );
        assert!(!format!("{remaining:?}").contains("SECRET"));
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
    fn jsonl_allows_an_escaped_near_limit_final_message() {
        let temp = TempRunDir::create("fake-codex-jsonl-near-final").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run_fake_with_limits(
            &temp,
            "jsonl-near-final-limit",
            None,
            Duration::from_secs(10),
            &cancelled,
            TRANSLATION_OUTPUT_LIMITS,
        );
        assert!(matches!(
            result,
            ProcessResult::Finished { success: true, .. }
        ));
    }

    #[cfg(windows)]
    #[test]
    fn translation_jsonl_limit_is_enforced_while_the_runner_is_alive() {
        let temp = TempRunDir::create("fake-codex-jsonl-output").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = run_fake_with_limits(
            &temp,
            "jsonl-overflow",
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
            context: crate::ai::AiPromptContext::isolated(0),
            default_path: PathBuf::from(r"C:\synthetic\default.json"),
            target_path: PathBuf::from(r"C:\synthetic\de.json"),
            expected_stored: None,
            expected_revision: 0,
        }];
        let translated = tauri::async_runtime::block_on(translate_chunk(
            None,
            "low",
            "German",
            true,
            &items,
            Arc::new(AtomicBool::new(false)),
            no_progress_callback(),
        ))
        .unwrap();
        assert_eq!(translated.len(), 1);
        assert_eq!(translated[0].id, "item-0000");
        assert!(!translated[0].text.trim().is_empty());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires an installed Codex CLI"]
    fn live_codex_model_list_uses_only_cli_reported_models() {
        let models = list_models_sync().unwrap();
        assert!(!models.is_empty());
        assert!(models.iter().all(|model| !model.model.trim().is_empty()));
        assert!(models.iter().any(|model| model.is_default));
    }
}
