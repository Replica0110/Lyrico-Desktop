//! Shared remote artwork service for previews and batch metadata.
const REMOTE_IMAGE_MAX_REDIRECTS: usize = 5;

pub(crate) fn fetch(url: &str, max_size: Option<u32>) -> Result<String, String> {
    let operation = crate::logging::Operation::new(
        "network",
        "artwork.fetch",
        serde_json::json!({"host":reqwest::Url::parse(url).ok().and_then(|url|url.host_str().map(str::to_owned)),"maxSize":max_size}),
        log::Level::Debug,
    );
    let result = fetch_inner(url, max_size);
    operation.finish(&result);
    result
}

fn fetch_inner(url: &str, max_size: Option<u32>) -> Result<String, String> {
    let mut current = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    for _ in 0..=REMOTE_IMAGE_MAX_REDIRECTS {
        if !matches!(current.scheme(), "http" | "https") {
            return Err("Only HTTP and HTTPS image URLs are supported".to_string());
        }
        let pinned = ensure_public_image_url(&current)?;
        let client = build_pinned_image_client(current.host_str(), pinned)?;
        let response = client
            .get(current.clone())
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_redirection() {
            let response = response
                .error_for_status()
                .map_err(|error| error.to_string())?;
            return encode_image_response(response, max_size);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "Image URL redirected without a Location header".to_string())?;
        current = current
            .join(location)
            .map_err(|error| format!("Image URL redirected to an invalid location: {error}"))?;
    }
    Err("Too many redirects while fetching the image".to_string())
}

fn build_pinned_image_client(
    host: Option<&str>,
    pinned: Option<std::net::SocketAddr>,
) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    if let (Some(domain), Some(address)) = (host, pinned) {
        let bare = domain
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .unwrap_or(domain);
        builder = builder.resolve(bare, address);
    }
    builder.build().map_err(|error| error.to_string())
}

fn encode_image_response(
    response: reqwest::blocking::Response,
    max_size: Option<u32>,
) -> Result<String, String> {
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("application/octet-stream")
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("Remote resource is not an image: {mime}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 20 * 1024 * 1024)
    {
        return Err("Remote image is larger than 20 MB".to_string());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    response
        .take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Remote image is larger than 20 MB".to_string());
    }
    use base64::Engine;
    image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    if let Some(max_size) = max_size {
        let max_size = max_size.clamp(64, 4096);
        let image = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
        let resized = image.thumbnail(max_size, max_size);
        let mut output = std::io::Cursor::new(Vec::new());
        resized
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        return Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(output.into_inner())
        ));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn ensure_public_image_url(url: &reqwest::Url) -> Result<Option<std::net::SocketAddr>, String> {
    use std::net::ToSocketAddrs;
    let host = url
        .host_str()
        .ok_or_else(|| "Image URL has no host".to_string())?;
    let bare = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = bare.parse::<std::net::IpAddr>() {
        ensure_public_image_ip(address)?;
        return Ok(None);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let mut pinned: Option<std::net::SocketAddr> = None;
    for address in (bare, port)
        .to_socket_addrs()
        .map_err(|error| format!("Failed to resolve image host {host}: {error}"))?
    {
        ensure_public_image_ip(address.ip())?;
        if pinned.is_none() {
            pinned = Some(address);
        }
    }
    match pinned {
        Some(address) => Ok(Some(address)),
        None => Err(format!("Image host {host} did not resolve to any address")),
    }
}

fn ensure_public_image_ip(address: std::net::IpAddr) -> Result<(), String> {
    let is_public = match address {
        std::net::IpAddr::V4(ip) => is_public_image_ipv4(ip),
        std::net::IpAddr::V6(ip) => is_public_image_ipv6(ip),
    };
    if is_public {
        Ok(())
    } else {
        Err(format!(
            "Refusing to fetch an image from a non-public address: {address}"
        ))
    }
}

fn is_public_image_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || octets[0] == 0
        || (octets[0] == 100 && (octets[1] & 0xc0) == 64)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || octets[0] >= 224)
}

fn is_public_image_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_image_ipv4(mapped);
    }
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || segments[0] == 0
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0xdb8)
        || (segments[0] == 0x0064 && segments[1] == 0xff9b))
}
