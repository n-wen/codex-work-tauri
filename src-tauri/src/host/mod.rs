//! Desktop-owned state and capabilities (not App Server resources).
//!
//! Settings, projects, cron, dynamic tools, and preview live here.
//! Turn orchestration stays in `runtime`; protocol I/O stays in `app_server`.

pub mod cron;
pub mod dynamic_tools;
pub mod preview;
pub mod projects;
pub mod settings;
pub mod store;
