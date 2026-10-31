//! A search term is data, never a URL, executable, or command line.
//! No database, credentials, subprocess shell, or background worker.

const PREFIX: &str = "https://www.google.com/search?q=";

pub fn google_search_url(query: &str) -> Result<String, &'static str> {
    if query.chars().any(char::is_control) {
        return Err("A pesquisa contém caracteres de controle.");
    }
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 1000 {
        return Err("Informe uma pesquisa com até 1.000 caracteres.");
    }
    // Encode every UTF-8 byte except RFC 3986 unreserved characters. In
    // particular &, #, %, quotes and shell metacharacters cannot change the URL.
    let mut url = String::from(PREFIX);
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in query.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            url.push(byte as char);
        } else {
            url.push('%');
            url.push(HEX[(byte >> 4) as usize] as char);
            url.push(HEX[(byte & 15) as usize] as char);
        }
    }
    Ok(url)
}

fn search_with(
    query: &str,
    open: impl FnOnce(&str) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let url = google_search_url(query)?;
    open(&url)
}

/// Success means Windows accepted the request; page loading is not observed.
pub fn open_google_search(query: &str) -> Result<(), &'static str> {
    search_with(query, platform_open)
}

pub fn open_weather_source(source: &str) -> Result<(), &'static str> {
    let url = match source {
        "open-meteo" => "https://open-meteo.com/",
        "geonames" => "https://www.geonames.org/",
        "license" => "https://creativecommons.org/licenses/by/4.0/",
        _ => return Err("Fonte inválida."),
    };
    platform_open(url)
}

#[cfg(not(windows))]
fn platform_open(_: &str) -> Result<(), &'static str> {
    Err("A abertura de pesquisas está disponível no Windows.")
}

#[cfg(windows)]
fn platform_open(url: &str) -> Result<(), &'static str> {
    use std::ffi::c_void;
    use std::ptr::null;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *const c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }
    let file: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let operation = [b'o' as u16, b'p' as u16, b'e' as u16, b'n' as u16, 0];
    // Source: https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew
    // Initialize STA + disable OLE1 DDE on the calling thread. Balance S_OK and
    // S_FALSE only; a failed initialization must never be uninitialized.
    // SAFETY: null reserved pointer and documented flag values, no borrowed data.
    let initialized = unsafe { CoInitializeEx(null(), 0x2 | 0x4) };
    if initialized < 0 {
        return Err("Não foi possível preparar a abertura do navegador.");
    }
    // SAFETY: both strings are owned, NUL-terminated UTF-16, alive for the call.
    // The file is exclusively the locally constructed HTTPS Google search URL.
    // No parameters, working directory, executable or elevated verb is accepted.
    let result =
        unsafe { ShellExecuteW(null(), operation.as_ptr(), file.as_ptr(), null(), null(), 1) };
    // SAFETY: initialization succeeded on this same thread, exactly once above.
    unsafe { CoUninitialize() };
    if result > 32 {
        Ok(())
    } else {
        Err("O Windows não confirmou a abertura da pesquisa.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_portuguese_as_a_google_query() {
        assert_eq!(
            google_search_url("  atualização do Windows  ").unwrap(),
            "https://www.google.com/search?q=atualiza%C3%A7%C3%A3o%20do%20Windows"
        );
    }

    #[test]
    fn hostile_arguments_remain_query_data() {
        for query in [
            "&q=other#fragment",
            "https://evil.test/?x=1",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/cmd.exe",
            "\" & calc.exe | powershell $(whoami)",
            "%26q=other",
        ] {
            let url = google_search_url(query).unwrap();
            let value = url.strip_prefix(PREFIX).unwrap();
            assert!(!value.contains(['&', '#', ':', '/', '"', ' ', '|', '$', '(', ')']));
            assert_eq!(url.matches('?').count(), 1);
            assert_eq!(url.matches('=').count(), 1);
        }
    }

    #[test]
    fn invalid_arguments_never_reach_the_opener() {
        for query in [
            "",
            "   ",
            "term\0",
            "term\n",
            "term\r",
            "term\t",
            &"x".repeat(1001),
        ] {
            assert!(search_with(query, |_| panic!("invalid search reached the OS")).is_err());
        }
        assert!(google_search_url(&"á".repeat(1000)).is_ok());
        assert!(open_weather_source("https://evil.test").is_err());
    }

    #[test]
    fn dispatches_one_controlled_url_and_propagates_failure_without_retry() {
        let mut calls = 0;
        let result = search_with("notebooks ASUS", |url| {
            calls += 1;
            assert_eq!(url, "https://www.google.com/search?q=notebooks%20ASUS");
            Err("simulated OS refusal")
        });
        assert_eq!(calls, 1);
        assert_eq!(result, Err("simulated OS refusal"));
    }
}
