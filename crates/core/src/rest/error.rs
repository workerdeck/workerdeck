use crate::vm::gateway::{answer_error, classify_answer};
use serde::de::DeserializeOwned;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestErrorKind {
    Transport,
    Auth,
    NotGateway,
    NotFound,
    Conflict,
    Refused,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestError {
    pub status: u16,
    pub kind: RestErrorKind,
    pub message: String,
}

pub const NO_ANSWER: &str = "The gateway did not answer";
pub const UNREADABLE: &str = "The gateway's answer could not be read";

// What came back for an `HttpCall`, as the platform received it; status 0 is no answer at all.
#[derive(Debug, Clone, Copy)]
pub struct Answer<'a> {
    pub status: u16,
    pub content_type: Option<&'a str>,
    pub body: &'a str,
}

impl<'a> Answer<'a> {
    pub fn new(status: u16, content_type: Option<&'a str>, body: &'a str) -> Self {
        Self { status, content_type, body }
    }

    pub fn error(&self) -> Option<RestError> {
        classify(self.status, self.content_type, self.body)
    }

    // A success whose JSON body does not have the expected shape is `Unreadable`.
    pub fn read<T: DeserializeOwned>(&self) -> Result<T, RestError> {
        if let Some(error) = self.error() {
            return Err(error);
        }
        serde_json::from_str(self.body).map_err(|_| RestError {
            status: self.status,
            kind: RestErrorKind::Unreadable,
            message: UNREADABLE.to_owned(),
        })
    }
}

// What an answer to an `HttpCall` means; `None` is a success whose body the caller may read. Status 0 is a request
// that got no answer at all. A 204 has no body, so it carries no content type to check.
pub fn classify(status: u16, content_type: Option<&str>, body: &str) -> Option<RestError> {
    if status == 0 {
        return Some(RestError { status, kind: RestErrorKind::Transport, message: NO_ANSWER.to_owned() });
    }
    if status == 204 {
        return None;
    }
    let message = answer_error(status, content_type, body)?;
    let kind = match status {
        401 | 403 => RestErrorKind::Auth,
        _ if classify_answer(200, content_type).is_some() => RestErrorKind::NotGateway,
        404 => RestErrorKind::NotFound,
        409 => RestErrorKind::Conflict,
        _ => RestErrorKind::Refused,
    };
    Some(RestError { status, kind, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: Option<&str> = Some("application/json; charset=utf-8");

    fn kind(status: u16, content_type: Option<&str>, body: &str) -> Option<(RestErrorKind, String)> {
        classify(status, content_type, body).map(|e| (e.kind, e.message))
    }

    #[test]
    fn a_json_success_and_an_empty_204_are_answers() {
        assert_eq!(classify(200, JSON, "{}"), None);
        assert_eq!(classify(201, Some("Application/JSON"), "{}"), None);
        assert_eq!(classify(204, None, ""), None);
    }

    #[test]
    fn an_answer_reads_its_body_or_says_why_not() {
        #[derive(serde::Deserialize, Debug, PartialEq)]
        struct Files {
            files: Vec<String>,
        }
        assert_eq!(Answer::new(200, JSON, r#"{"files":["a"]}"#).read::<Files>(), Ok(Files { files: vec!["a".into()] }));
        assert_eq!(Answer::new(200, JSON, r#"{"nope":1}"#).read::<Files>().map_err(|e| e.kind), Err(RestErrorKind::Unreadable));
        assert_eq!(Answer::new(404, JSON, r#"{"error":"gone"}"#).read::<Files>().map_err(|e| e.message), Err("gone".into()));
    }

    #[test]
    fn no_answer_is_a_transport_failure() {
        assert_eq!(classify(0, None, ""), Some(RestError { status: 0, kind: RestErrorKind::Transport, message: NO_ANSWER.into() }));
    }

    #[test]
    fn html_or_a_refused_key_means_the_address_or_key_is_wrong() {
        let wrong = "Not a WorkerDeck gateway, or the auth key is wrong".to_owned();
        assert_eq!(kind(200, Some("text/html"), "<html>"), Some((RestErrorKind::NotGateway, wrong.clone())));
        assert_eq!(kind(404, None, ""), Some((RestErrorKind::NotGateway, wrong)));
        assert_eq!(kind(401, JSON, r#"{"error":"x"}"#), Some((RestErrorKind::Auth, "The gateway refused the auth key".into())));
        assert_eq!(kind(403, Some("text/html"), ""), Some((RestErrorKind::Auth, "The gateway refused the auth key".into())));
    }

    #[test]
    fn a_refusal_carries_the_gateways_reason() {
        assert_eq!(
            kind(404, JSON, r#"{"error":"no running task to stop"}"#),
            Some((RestErrorKind::NotFound, "no running task to stop".into()))
        );
        assert_eq!(kind(409, JSON, r#"{"error":"parked"}"#), Some((RestErrorKind::Conflict, "parked".into())));
        assert_eq!(kind(501, JSON, r#"{"error":" "}"#), Some((RestErrorKind::Refused, "The gateway answered 501".into())));
        assert_eq!(kind(500, JSON, "not json"), Some((RestErrorKind::Refused, "The gateway answered 500".into())));
    }
}
