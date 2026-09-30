//! Shared cloud-engine data contracts; no authentication or process execution.
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderPhase {
    Translating,
    Reviewing,
    TerminologyRepair,
    TokenRepair,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderActivity {
    Starting,
    Working,
    Reasoning,
    WritingResponse,
    Completed,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) struct ProviderTokenUsage {
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub reasoning_output_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProviderProgressEvent {
    /// Structurally valid drafts, before review/repairs and persistence.
    DraftsReady {
        ids: Vec<String>,
    },
    Phase {
        phase: ProviderPhase,
        item_count: usize,
    },
    TransientRetry,
    StructureRetry,
    Split,
    /// The quality review of `item_count` strings could not complete; their
    /// structurally valid drafts are kept instead.
    ReviewSkipped {
        item_count: usize,
        reason: ReviewSkipReason,
    },
    Activity(ProviderActivity),
    Usage(ProviderTokenUsage),
}

/// Why a review batch was skipped. Only failures that already went through the
/// bounded recovery keep drafts; configuration errors abort the run instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReviewSkipReason {
    /// A transient cloud-provider failure persisted after its one retry.
    Transient,
    /// A single-item review response stayed invalid after its structure retry.
    InvalidResponse,
}

pub(crate) type ProviderProgressCallback = Arc<dyn Fn(ProviderProgressEvent) + Send + Sync>;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiStatus {
    pub authenticated: bool,
    pub sign_in_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authentication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAiModel {
    /// Exact model identifier accepted by the selected cloud transport.
    pub model: String,
    pub display_name: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    pub supported_reasoning_efforts: Vec<String>,
}
