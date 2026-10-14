use wd_native::vm::prompt::{self as core, PromptBody};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PromptKind {
    Permission,
    Plan,
    Shell,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ChoiceKey {
    Allow,
    Deny,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PromptChoice {
    pub key: ChoiceKey,
    pub button: String,
    pub option: String,
    pub danger: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Prompt {
    pub request_id: String,
    pub tool_name: String,
    pub kind: PromptKind,
    pub waiting: u32,
    pub heading: String,
    pub subject: Option<String>,
    pub shell_lines: Vec<String>,
    pub description: Option<String>,
    pub decision_reason: Option<String>,
    pub question: String,
    pub choices: Vec<PromptChoice>,
    pub deny_placeholder: String,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct Selection {
    pub labels: Vec<String>,
    pub other: String,
    pub other_active: bool,
}

impl From<Selection> for core::Selection {
    fn from(s: Selection) -> Self {
        core::Selection { labels: s.labels, other: s.other, other_active: s.other_active }
    }
}

impl From<core::Selection> for Selection {
    fn from(s: core::Selection) -> Self {
        Selection { labels: s.labels, other: s.other, other_active: s.other_active }
    }
}

#[uniffi::export]
pub fn answer_text(selection: Selection) -> String {
    core::answer_for(&selection.into())
}

#[uniffi::export]
pub fn toggle_label(selection: Selection, label: String, multi_select: bool) -> Selection {
    core::toggle_label(&selection.into(), &label, multi_select).into()
}

#[uniffi::export]
pub fn toggle_other(selection: Selection, multi_select: bool) -> Selection {
    core::toggle_other(&selection.into(), multi_select).into()
}

impl From<core::Prompt> for Prompt {
    fn from(p: core::Prompt) -> Self {
        let mut prompt = Prompt {
            request_id: p.request_id,
            tool_name: p.tool_name,
            kind: PromptKind::Permission,
            waiting: p.waiting as u32,
            heading: String::new(),
            subject: None,
            shell_lines: Vec::new(),
            description: None,
            decision_reason: None,
            question: String::new(),
            choices: Vec::new(),
            deny_placeholder: String::new(),
            questions: Vec::new(),
        };
        match p.body {
            PromptBody::Permission { model, subject, shell_lines } => {
                prompt.kind = if model.plan.is_some() {
                    PromptKind::Plan
                } else if model.shell.is_some() {
                    PromptKind::Shell
                } else {
                    PromptKind::Permission
                };
                prompt.heading = model.heading;
                prompt.subject = subject;
                prompt.shell_lines = shell_lines;
                prompt.description = model.description;
                prompt.decision_reason = model.decision_reason;
                prompt.question = model.question.to_owned();
                prompt.deny_placeholder = model.deny_placeholder.to_owned();
                prompt.choices = model
                    .choices
                    .into_iter()
                    .map(|c| PromptChoice {
                        key: match c.key {
                            core::ChoiceKey::Allow => ChoiceKey::Allow,
                            core::ChoiceKey::Deny => ChoiceKey::Deny,
                            core::ChoiceKey::Stop => ChoiceKey::Stop,
                        },
                        button: c.button.to_owned(),
                        option: c.option.to_owned(),
                        danger: c.danger == Some(true),
                    })
                    .collect();
            }
            PromptBody::Question { title, questions } => {
                prompt.kind = PromptKind::Question;
                prompt.heading = title;
                prompt.questions = questions
                    .into_iter()
                    .map(|q| Question {
                        question: q.question,
                        header: q.header,
                        multi_select: q.multi_select,
                        options: q
                            .options
                            .into_iter()
                            .map(|o| QuestionOption { label: o.label, description: o.description, preview: o.preview })
                            .collect(),
                    })
                    .collect();
            }
        }
        prompt
    }
}
