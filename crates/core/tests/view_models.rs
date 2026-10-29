use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use wd_native::projection::project;
use wd_native::protocol::{Frame, decode_frame};
use wd_native::rest::{AgentInfo, ByModel, ChecklistItem, Entries, ModelOption, SessionInfo, SubagentInfo, TokenUsage};
use wd_native::transcript::{
    TranscriptState, apply_event, hydrate_shell_output, hydrate_shell_row, hydrate_tool_result, seed_from_session_info,
};
use wd_native::vm::conversations::{self, CurrentConversation, SessionAddress};
use wd_native::vm::face::{self, FaceOptions, FaceState, FaceTheme};
use wd_native::vm::session_list::{self as sl, CustomGroup, SessionRow, ViewConfig};
use wd_native::vm::status_label::StatusLabelRead;
use wd_native::vm::watermarks::{Watermark, Watermarks};
use wd_native::vm::{agents, checklist, model_menu, peer_mentions, pricing, tool_titles, usage, watermarks};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/view-models")
}

fn close(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a == b || (a - b).abs() <= 4.0 * f64::EPSILON * a.abs().max(b.abs()),
        _ => false,
    }
}

fn diff(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) if close(a.as_f64(), b.as_f64()) => {}
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => diff(&format!("{path}.{key}"), value, other, out),
                    None => out.push(format!("{path}.{key}: missing, want {value}")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                out.push(format!("{path}.{key}: unexpected {}", b[key]));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{path}: {} entries, want {}", b.len(), a.len()));
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                diff(&format!("{path}[{index}]"), x, y, out);
            }
        }
        _ if want == got => {}
        _ => out.push(format!("{path}: got {got}, want {want}")),
    }
}

struct Args<'a>(&'a [Value]);

impl Args<'_> {
    fn raw(&self, index: usize) -> &Value {
        self.0.get(index).unwrap_or(&Value::Null)
    }

    fn get<T: DeserializeOwned>(&self, index: usize) -> T {
        serde_json::from_value(self.raw(index).clone()).unwrap_or_else(|e| panic!("arg {index}: {e}: {}", self.raw(index)))
    }

    fn opt<T: DeserializeOwned>(&self, index: usize) -> Option<T> {
        self.get(index)
    }

    fn str(&self, index: usize) -> Option<String> {
        self.raw(index).as_str().map(str::to_owned)
    }

    fn info(&self, index: usize) -> SessionInfo {
        let value = self.raw(index);
        serde_json::from_value(value.get("info").unwrap_or(value).clone()).expect("session info")
    }
}

fn out<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("serialize")
}

fn default_table() -> pricing::PricingTable {
    pricing::default_pricing()
}

fn task_sources(value: &Value) -> (Vec<ChecklistItem>, Vec<SubagentInfo>) {
    let field = |key: &str| value.get(key).cloned().unwrap_or(json!([]));
    (serde_json::from_value(field("checklist")).expect("checklist"), serde_json::from_value(field("subagents")).expect("subagents"))
}

fn session_list(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "groupRows" => {
            let rows: Vec<SessionRow> = a.get(0);
            out(sl::group_rows(&rows, &a.get(1), &a.opt(2).unwrap_or_default()))
        }
        "sessionState" => out(sl::session_state(&a.info(0))),
        "visibleSubagents" => out(sl::visible_subagents(&a.info(0), a.get(1))),
        "runningSubagents" => out(sl::running_subagents(&a.info(0))),
        "subagentLabel" => out(sl::subagent_label(&a.get(0))),
        "isAgentRecord" => out(sl::is_agent_record(&a.get(0))),
        "relayHostsOf" => out(sl::relay_hosts_of(&a.get(0))),
        "sessionKey" => {
            let row: SessionRow = a.get(0);
            out(sl::session_key(&row.host_id, &row.info.id))
        }
        "normalizeViewConfig" => out(sl::normalize_view_config(Some(a.raw(0)).filter(|v| !v.is_null()))),
        "adaptersOf" => out(sl::adapters_of(&a.get::<Vec<SessionRow>>(0))),
        "projectsOf" => out(sl::projects_of(&a.get::<Vec<SessionRow>>(0))),
        "sessionLabel" => out(sl::session_label(&a.info(0))),
        "projectKey" => out(sl::project_key(&a.get(0))),
        "projectLabel" => out(sl::project_label(&a.info(0))),
        "projectName" => out(sl::project_name(&a.info(0))),
        "projectSubpath" => out(sl::project_subpath(&a.info(0))),
        "isJobRun" => out(sl::is_job_run(&a.info(0))),
        "promotedShells" => out(sl::promoted_shells(&a.info(0), a.get(1))),
        "visibleShells" => out(sl::visible_shells(&a.info(0), a.get(1), a.get(2))),
        "inScope" => out(sl::in_scope(&a.get(0), &a.get(1))),
        "scopeActive" => out(sl::scope_active(&a.get(0), a.opt::<sl::WorkspaceScope>(1).as_ref())),
        "filterRows" => {
            let rows: Vec<SessionRow> = a.get(0);
            out(sl::filter_rows(&rows, &a.get(1), a.opt::<sl::WorkspaceScope>(2).as_ref()))
        }
        "teamKey" => out(sl::team_key(&a.get(0))),
        "teamState" => out(sl::team_state(&a.get::<Vec<SessionRow>>(0))),
        "toggleTeamExpanded" => out(sl::toggle_team_expanded(&a.get(0), &a.get(1))),
        "isTeamExpanded" => out(sl::is_team_expanded(&a.get(0), &a.get(1))),
        "teamView" => out(sl::team_view(&a.get(0), &a.get(1), a.str(2).as_deref(), a.get(3), None)),
        "teamViewPeeked" => {
            let peeked: HashSet<String> = a.get(4);
            out(sl::team_view(&a.get(0), &a.get(1), a.str(2).as_deref(), a.get(3), Some(&peeked)))
        }
        "teamLingerStartPeeked" => {
            let peeked: HashSet<String> = a.get(3);
            out(sl::team_linger_start(&a.get(0), a.str(1).as_deref(), a.get(2), Some(&peeked)))
        }
        "groupFoldSummary" => out(sl::group_fold_summary(&serde_json::from_value::<Vec<SessionRow>>(a.raw(0)["rows"].clone()).unwrap())),
        "stepChips" => {
            let steps: Vec<wd_native::vm::steps::FoldStep> = a.get(0);
            out(wd_native::vm::steps::step_chips(&steps, &a.get::<Vec<sl::FoldableStepKind>>(1), a.str(2).as_deref()))
        }
        "expandedStepsScript" => {
            let mut config: ViewConfig = a.get(0);
            let ops: Vec<(String, String, sl::FoldableStepKind)> = a.get(1);
            out(ops
                .into_iter()
                .map(|(host, id, kind)| {
                    config = sl::toggle_steps_expanded(&config, &host, &id, kind);
                    serde_json::json!({ "expandedSteps": config.expanded_steps, "s1": sl::expanded_steps_of(&config, &host, "s1") })
                })
                .collect::<Vec<_>>())
        }
        "orderGroups" => out(sl::order_groups(&a.get::<Vec<sl::SessionGroup>>(0), &a.get(1))),
        "moveGroup" => out(sl::move_group(&a.get(0), &a.get::<Vec<sl::SessionGroup>>(1), &a.str(2).unwrap(), &a.str(3).unwrap())),
        "resetGroupOrder" => out(sl::reset_group_order(&a.get(0))),
        "teamLingerEnds" => out(sl::team_linger_ends(&a.get(0), a.get(1))),
        "toggleGroupCollapsed" => out(sl::toggle_group_collapsed(&a.get(0), a.raw(1)["key"].as_str().unwrap())),
        "isGroupCollapsed" => out(sl::is_group_collapsed(&a.get(0), a.raw(1)["key"].as_str().unwrap())),
        "groupSummary" => out(sl::group_summary(&serde_json::from_value::<Vec<SessionRow>>(a.raw(0)["rows"].clone()).unwrap())),
        "teamSummary" => out(sl::team_summary(&a.get(0))),
        "customGroupColor" => out(sl::custom_group_color(&a.get(0))),
        "customGroupScript" => {
            let groups: Vec<CustomGroup> = a.get(0);
            let op = Args(a.raw(1).as_array().unwrap());
            let name = op.str(1).unwrap();
            out(match op.str(0).unwrap().as_str() {
                "add" => sl::add_custom_group(&groups, &name, &op.str(2).unwrap()),
                "rename" => sl::rename_custom_group(&groups, &name, &op.str(2).unwrap()),
                "remove" => sl::remove_custom_group(&groups, &name),
                "moveTo" => sl::move_to_custom_group(&groups, &name, op.str(2).as_deref(), op.str(3).as_deref()),
                "move" => sl::move_custom_group(&groups, &name, op.str(2).as_deref()),
                _ => sl::style_custom_group(&groups, &name, &op.get(2)),
            })
        }
        "subsetSummary" => out(sl::subset_summary(&a.get(0), a.opt::<sl::WorkspaceScope>(1).as_ref(), a.get(2), a.get(3))),
        "filterEngagement" => {
            let config: ViewConfig = a.get(0);
            json!({
                "hasFacetFilter": sl::has_facet_filter(&config),
                "facetFilterCount": sl::facet_filter_count(&config),
                "displayCustomized": sl::display_customized(&config),
            })
        }
        "clearFilters" => out(sl::clear_filters(&a.get(0))),
        _ => panic!("session-list.{fn_name} has no Rust binding"),
    }
}

fn agents_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "agentRef" => out(agents::agent_ref(&a.get::<AgentInfo>(0), &a.get(1))),
        "teamRole" => out(agents::team_role(a.opt(0).as_ref())),
        "teamReaches" => out(agents::team_reaches(a.opt(0).as_ref(), a.opt(1).as_ref())),
        "teamRelated" => out(agents::team_related(a.opt(0).as_ref(), a.opt(1).as_ref())),
        "peerOps" => out(agents::peer_ops(&a.get(0), &a.get(1), a.get(2))),
        "isOwnerName" => out(agents::is_owner_name(&a.str(0).unwrap())),
        "qualifyAgent" => out(agents::qualify_agent(a.opt(0).as_ref(), &a.str(1).unwrap())),
        "projectAccent" => out(agents::project_accent(&a.str(0).unwrap())),
        "newAgentDefaults" => {
            let (defaults, profile) = (a.opt(0), a.opt(1));
            json!({
                "owner": agents::new_agent_owner(defaults.as_ref(), profile.as_ref()),
                "sharing": agents::new_agent_sharing(defaults.as_ref(), profile.as_ref()),
            })
        }
        _ => panic!("agents.{fn_name} has no Rust binding"),
    }
}

fn pricing_fn(fn_name: &str, a: &Args) -> Value {
    let table = default_table();
    match fn_name {
        "defaultPricing" => out(&table),
        "canonicalModel" => out(pricing::canonical_model(&a.str(0).unwrap())),
        "rateFor" => out(pricing::rate_for(a.str(0).as_deref(), &table)),
        "costOf" => out(pricing::cost_of(&a.get::<TokenUsage>(0), a.str(1).as_deref(), &table)),
        "costOfByModel" => out(pricing::cost_of_by_model(&a.get::<ByModel>(0), &table)),
        "tokenUsageFromWire" => out(pricing::token_usage_from_wire(a.raw(0))),
        "addTokenUsage" => out(pricing::add_token_usage(&a.get(0), &a.get(1))),
        "mergeByModel" => out(pricing::merge_by_model(&a.get(0), &a.get(1))),
        "byModelTotalTokens" => out(pricing::by_model_total_tokens(&a.get(0))),
        "unknownBasisModels" => out(pricing::unknown_basis_models(&a.get(0))),
        "unpricedModels" => out(pricing::unpriced_models(&a.get(0), &table)),
        "worseBasis" => out(pricing::worse_basis(a.opt(0), a.opt(1))),
        "meteredCostOf" => out(pricing::metered_cost(&pricing::cost_of_by_model(&a.get(0), &table))),
        "subscriptionComparison" => out(pricing::subscription_comparison(a.get(0), a.get(1))),
        "pricingAge" => {
            let as_of = a.str(1).unwrap_or_else(|| pricing::PRICING_AS_OF.to_owned());
            json!({
                "days": pricing::pricing_age_days(a.get(0), &as_of),
                "note": pricing::pricing_age_note(a.get(0), &as_of),
            })
        }
        "mergePricing" => out(pricing::merge_pricing(a.raw(0), &table)),
        _ => panic!("pricing.{fn_name} has no Rust binding"),
    }
}

fn usage_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "mergeUsage" => out(usage::merge_usage(&a.get(0), a.opt(1).as_ref())),
        "usageIsStale" => {
            let row = a.raw(0);
            out(usage::usage_is_stale(row["updatedAt"].as_f64(), row["inferredReset"].as_bool() == Some(true), a.get(1)))
        }
        "orderUsageWindows" => out(usage::order_usage_windows(a.opt(0).as_ref())),
        "usageInfos" => out(usage::usage_infos(a.opt(0).as_ref())),
        _ => panic!("usage.{fn_name} has no Rust binding"),
    }
}

fn watermarks_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "watermarkScript" => {
            let mut marks = Watermarks::from_json(Some(&a.get::<Value>(0).to_string()));
            let mut writes = Vec::new();
            let mut results = Vec::new();
            for op in a.raw(1).as_array().unwrap() {
                let op = Args(op.as_array().unwrap());
                let (host, session) = (op.str(1).unwrap(), op.str(2).unwrap());
                let wrote = match op.str(0).unwrap().as_str() {
                    "mark" => marks.mark(&host, &session, &op.get(3), op.get(4)),
                    _ => marks.forget(&host, &session),
                };
                if wrote {
                    writes.push(out(marks.all()));
                }
                results.push(wrote);
            }
            json!({ "results": results, "writes": writes, "marks": out(marks.all()) })
        }
        "catchUpItems" => {
            let mark = a.raw(0);
            out(watermarks::catch_up_items(mark["itemCount"].as_f64().unwrap(), mark["conversation"].as_f64(), a.raw(1).as_f64()))
        }
        "unseenCount" => out(watermarks::unseen_count(a.opt::<Watermark>(0).as_ref(), a.raw(1)["proseCount"].as_f64())),
        _ => panic!("watermarks.{fn_name} has no Rust binding"),
    }
}

fn peer_mentions_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "scanPeerMentions" => out(peer_mentions::scan_peer_mentions(&a.str(0).unwrap())),
        "peerMentionSlug" => out(peer_mentions::peer_mention_slug(a.str(0).as_deref(), &a.str(1).unwrap())),
        "peerMentionKey" => out(peer_mentions::peer_mention_key(&a.str(0).unwrap())),
        "isPeerMentionBody" => out(peer_mentions::is_peer_mention_body(&a.str(0).unwrap())),
        _ => panic!("peer-mentions.{fn_name} has no Rust binding"),
    }
}

fn checklist_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "parseTodoWriteInput" => out(checklist::parse_todo_write_input(a.raw(0))),
        "sessionTasks" => {
            let (items, subs) = task_sources(a.raw(0));
            out(checklist::session_tasks(&items, &subs))
        }
        "displayedTasks" => {
            let (items, subs) = task_sources(a.raw(0));
            out(checklist::displayed_tasks(&items, &subs, a.get(1)))
        }
        "taskScript" => {
            let (items, subs) = task_sources(a.raw(0));
            let tasks = checklist::session_tasks(&items, &subs);
            let summary = checklist::task_summary(&tasks);
            json!({
                "summary": out(summary),
                "label": checklist::task_count_label(&summary),
                "hidden": out(checklist::visible_tasks(&tasks, false)),
                "shown": out(checklist::visible_tasks(&tasks, true)),
            })
        }
        _ => panic!("checklist.{fn_name} has no Rust binding"),
    }
}

fn tool_titles_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "toolTitle" => out(tool_titles::tool_title(&a.str(0).unwrap(), a.opt::<Entries<String>>(1).as_ref())),
        "sanitizeToolTitle" => out(tool_titles::sanitize_tool_title(a.str(0).as_deref(), a.str(1).as_deref())),
        "isPeerSendTool" => out(tool_titles::is_peer_send_tool(&a.str(0).unwrap())),
        _ => panic!("tool-titles.{fn_name} has no Rust binding"),
    }
}

fn model_menu_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "modelLine" => out(model_menu::model_line(&a.get(0))),
        "modelMatches" => out(model_menu::model_matches(&a.get(0), &a.str(1).unwrap())),
        "modelMenu" => out(model_menu::model_menu(&a.get::<Vec<ModelOption>>(0), a.str(1).as_deref())),
        _ => panic!("model-menu.{fn_name} has no Rust binding"),
    }
}

fn status_label_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "readStatusLabelInput" => match wd_native::vm::status_label::read_status_label_input(a.0.first()) {
            StatusLabelRead::Clear => Value::Null,
            StatusLabelRead::Set(input) => out(input),
            StatusLabelRead::Refused(reason) => Value::String(reason),
        },
        _ => panic!("status-label.{fn_name} has no Rust binding"),
    }
}

fn prompt_fn(fn_name: &str, a: &Args) -> Value {
    use wd_native::vm::prompt::{self, ShellRequest};
    match fn_name {
        "permissionPromptModel" => out(prompt::permission_prompt_model(a.raw(0))),
        "shellRequestLines" => {
            let raw = a.raw(0);
            let field = |key: &str| raw.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let payload = match raw["kind"].as_str().unwrap() {
                "run" => ShellRequest::Run { command: field("command") },
                "write" => ShellRequest::Write {
                    shell_id: field("shellId"),
                    data: raw.get("data").and_then(Value::as_str).map(str::to_owned),
                    keys: raw.get("keys").map(|keys| serde_json::from_value(keys.clone()).unwrap()),
                },
                "kill" => ShellRequest::Kill { shell_id: field("shellId") },
                _ => ShellRequest::Grant { shell_id: field("shellId"), reason: field("reason") },
            };
            out(prompt::shell_request_lines(&payload))
        }
        "parseUserQuestions" => out(prompt::parse_user_questions(a.raw(0))),
        "selectionScript" => {
            let multi = a.raw(0).as_bool().unwrap();
            let mut selection = prompt::Selection::default();
            let steps: Vec<Value> = a
                .raw(1)
                .as_array()
                .unwrap()
                .iter()
                .map(|op| {
                    let value = op.get(1).and_then(Value::as_str).unwrap_or_default();
                    selection = match op[0].as_str().unwrap() {
                        "label" => prompt::toggle_label(&selection, value, multi),
                        "other" => prompt::toggle_other(&selection, multi),
                        _ => prompt::Selection { other: value.to_owned(), ..selection.clone() },
                    };
                    json!({ "selection": out(&selection), "answer": prompt::answer_for(&selection) })
                })
                .collect();
            Value::Array(steps)
        }
        _ => panic!("prompt.{fn_name} has no Rust binding"),
    }
}

fn transcript_fn(fn_name: &str, a: &Args) -> Value {
    assert_eq!(fn_name, "transcriptScript", "transcript.{fn_name} has no Rust binding");
    let mut state = TranscriptState::default();
    let apply = |state: &mut TranscriptState, line: &[u8]| {
        if let Some(Frame::Event(event)) = decode_frame(line) {
            apply_event(state, event);
        }
    };
    for op in a.raw(0).as_array().unwrap() {
        let op = op.as_array().unwrap();
        let text = |index: usize| op[index].as_str().unwrap().to_owned();
        match op[0].as_str().unwrap() {
            "events" => {
                let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/conformance/{}.events.jsonl", text(1)));
                for line in std::fs::read(path).unwrap().split(|&b| b == b'\n').filter(|line| !line.is_empty()) {
                    apply(&mut state, line);
                }
            }
            "effort" => {
                let frame =
                    json!({"type": "event", "event": {"type": "effort_changed", "effort": op[1], "seq": state.last_seq + 1, "ts": 1}});
                apply(&mut state, frame.to_string().as_bytes());
            }
            "seed" => seed_from_session_info(&mut state, &serde_json::from_value(op[1].clone()).unwrap()),
            "hydrateResult" => {
                hydrate_tool_result(&mut state, &text(1), &text(2));
            }
            "hydrateShell" => {
                hydrate_shell_row(&mut state, &text(1), (!op[2].is_null()).then(|| Arc::new(op[2].clone())));
            }
            _ => {
                hydrate_shell_output(&mut state, &text(1), &text(2));
            }
        }
    }
    project(&state)
}

fn face_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "resolveAgentFace" => out(face::resolve_agent_face(Some(a.raw(0)))),
        "projectSwatch" => out(face::project_swatch(&a.str(0).unwrap())),
        "faceStateOf" => out(face::face_state_of(&a.get::<SessionRow>(0), a.opt(1))),
        "faceTree" => {
            let o = a.raw(0);
            let field = |key: &str| o.get(key).filter(|v| !v.is_null());
            let resolved = face::resolve_agent_face(field("face"));
            let tree = face::face_tree(&FaceOptions {
                face: &resolved,
                project: field("project").and_then(Value::as_str).unwrap(),
                state: serde_json::from_value::<FaceState>(field("state").cloned().unwrap()).unwrap(),
                size: field("size").and_then(Value::as_f64).unwrap(),
                id: field("id").and_then(Value::as_str).unwrap(),
                context: field("context").and_then(Value::as_f64),
                threshold: field("threshold").and_then(Value::as_f64),
                phase: field("phase").and_then(Value::as_str),
                theme: serde_json::from_value::<FaceTheme>(field("theme").cloned().unwrap()).unwrap(),
            });
            tree.to_json()
        }
        _ => panic!("face.{fn_name} has no Rust binding"),
    }
}

fn conversations_fn(fn_name: &str, a: &Args) -> Value {
    match fn_name {
        "archivedView" => {
            let address: SessionAddress = a.get(0);
            let current: Option<CurrentConversation> = a.opt(2);
            out(conversations::archived_view(&address, Some(&a.info(1)), current.as_ref()))
        }
        "newConversationGate" => out(conversations::new_conversation_gate(Some(&a.info(0)))),
        "clearContextOffered" => out(conversations::clear_context_offered(&a.info(0))),
        "canSleep" => out(wd_native::vm::session_list::can_sleep(&a.info(0))),
        _ => panic!("conversations.{fn_name} has no Rust binding"),
    }
}

fn run(module: &str, fn_name: &str, args: &[Value]) -> Value {
    let a = Args(args);
    match module {
        "session-list" => session_list(fn_name, &a),
        "agents" => agents_fn(fn_name, &a),
        "pricing" => pricing_fn(fn_name, &a),
        "usage" => usage_fn(fn_name, &a),
        "watermarks" => watermarks_fn(fn_name, &a),
        "peer-mentions" => peer_mentions_fn(fn_name, &a),
        "checklist" => checklist_fn(fn_name, &a),
        "tool-titles" => tool_titles_fn(fn_name, &a),
        "model-menu" => model_menu_fn(fn_name, &a),
        "status-label" => status_label_fn(fn_name, &a),
        "transcript" => transcript_fn(fn_name, &a),
        "prompt" => prompt_fn(fn_name, &a),
        "conversations" => conversations_fn(fn_name, &a),
        "face" => face_fn(fn_name, &a),
        _ => panic!("unknown view-model module {module}"),
    }
}

#[test]
fn view_models_match_typescript() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir())
        .expect("goldens: run `pnpm fixtures:vm`")
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no view-model goldens");
    let mut failures = Vec::new();
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let module = name.split('.').next().unwrap();
        let golden: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).expect("json");
        let fn_name = golden["input"]["fn"].as_str().unwrap();
        let calls = golden["input"]["calls"].as_array().unwrap();
        let want = golden["output"].as_array().unwrap();
        for (index, (call, want)) in calls.iter().zip(want).enumerate() {
            let got = run(module, fn_name, call.as_array().unwrap());
            let mut out = Vec::new();
            diff("", want, &got, &mut out);
            failures.extend(out.into_iter().take(6).map(|line| format!("{name} {fn_name}#{index}{line}")));
        }
    }
    assert!(failures.is_empty(), "{} view-model mismatches:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn forgetting_a_host_drops_only_its_marks() {
    use wd_native::vm::watermarks::{Seen, Watermarks};
    let mut marks = Watermarks::default();
    let seen = Seen { activity: Some(3.0), ..Seen::default() };
    marks.mark("gw-a", "s1", &seen, 1.0);
    marks.mark("gw-ab", "s1", &seen, 1.0);
    assert!(marks.forget_host("gw-a"));
    assert!(marks.get("gw-a", "s1").is_none());
    assert!(marks.get("gw-ab", "s1").is_some());
    assert!(!marks.forget_host("gw-a"));
}
