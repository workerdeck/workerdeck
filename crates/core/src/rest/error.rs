use crate::vm::gateway::{answer_error, classify_answer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestErrorKind {
    Transport,
    Auth,
    NotGateway,
    NotFound,
    Conflict,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestError {
    pub status: u16,
    pub kind: RestErrorKind,
    pub message: String,
}

pub const NO_ANSWER: &str = "The gateway did not answer";

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
