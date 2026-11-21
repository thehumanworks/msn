use std::fmt;

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("{0}")]
    Generic(String),
    #[error("{0}")]
    Usage(String),
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Network(String),
    /// A bounded wait ended with nothing to report (ADR 0065: `msn ask --wait`).
    #[error("{0}")]
    Timeout(String),
}

impl CliError {
    pub fn generic(message: impl Into<String>) -> Self {
        Self::Generic(message.into())
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::Usage(message.into())
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::Auth(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::Timeout(message.into())
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::Network(message.into())
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Generic(_) => 1,
            Self::Usage(_) => 2,
            Self::Auth(_) => 3,
            Self::NotFound(_) => 4,
            Self::Conflict(_) => 5,
            Self::Network(_) => 6,
            Self::Timeout(_) => 2,
        }
    }
}

impl From<url::ParseError> for CliError {
    fn from(_: url::ParseError) -> Self {
        Self::usage("MSN_URL must be a server origin without credentials, path, query or fragment.")
    }
}

impl From<std::io::Error> for CliError {
    fn from(error: std::io::Error) -> Self {
        Self::generic(error.to_string())
    }
}

pub fn write_err(error: &CliError) {
    let _ = writeln_stderr(error);
}

fn writeln_stderr(error: &impl fmt::Display) -> std::io::Result<()> {
    use std::io::Write;
    let mut out = std::io::stderr().lock();
    writeln!(out, "{error}")
}
