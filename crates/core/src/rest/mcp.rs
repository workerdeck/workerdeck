use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAnnotations {
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub destructive: Option<bool>,
    #[serde(default)]
    pub open_world: Option<bool>,
}

// `input_schema` is engine-dependent: codex reports each tool's JSON Schema, the Agent SDK none.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub annotations: Option<McpAnnotations>,
    #[serde(default)]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
}

// The gateway drops a server's `env` and `headers` before answering.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub server_info: Option<McpServerInfo>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<McpTool>>,
}

impl McpServer {
    pub fn is_connected(&self) -> bool {
        self.status == "connected"
    }

    pub fn is_disabled(&self) -> bool {
        self.status == "disabled"
    }

    pub fn tool_count(&self) -> usize {
        self.tools.as_ref().map_or(0, Vec::len)
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct McpServers {
    pub servers: Vec<McpServer>,
}
