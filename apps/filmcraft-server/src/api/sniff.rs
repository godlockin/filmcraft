//! Content-type sniffing for media uploads and downloads.
//!
//! The engine's `media.import` is the source of truth for which formats we
//! can actually open; this layer only filters out obvious garbage at the
//! API boundary so the upload endpoint isn't a vector for "post any bytes,
//! see what the explorer thinks".
//!
//! The actual `Content-Type` for the *download* side picks one of
//! `video/mp4`, `video/webm`, `audio/wav`, `image/png`, `image/jpeg`, or
//! `application/octet-stream` based on the same sniffs.

/// Sniff an MP4/MOV file by checking the `ftyp` box header at offset 4.
/// Returns `true` for ISO base media file format files. Other formats are
/// not yet validated here — the engine's `media.import` will reject
/// unsupported kinds downstream. We catch the most common abuse (random
/// bytes uploaded as "media") at the door.
pub fn looks_like_mp4(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    // Box header: 4 bytes big-endian size, 4 bytes ASCII type. For an MP4
    // the first box is `ftyp`.
    &bytes[4..8] == b"ftyp"
}

/// Extend the media-kind sniff with a few more containers so we don't
/// reject common web formats.
pub fn looks_like_known_other(bytes: &[u8]) -> bool {
    // WAV: "RIFF" .... "WAVE"
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return true;
    }
    // Matroska / WebM: 0x1A 0x45 0xDF 0xA3
    if bytes.len() >= 4 && bytes[0] == 0x1A && bytes[1] == 0x45 && bytes[2] == 0xDF && bytes[3] == 0xA3 {
        return true;
    }
    // PNG
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return true;
    }
    // JPEG
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return true;
    }
    false
}

/// Sniff a `Content-Type` for the media-download endpoint. The download
/// side gets the file's bytes (not the upload body); we read the prefix
/// lazily so a 4 GiB mp4 is not read into memory.
///
/// We compose from `looks_like_mp4` and `looks_like_known_other` plus the
/// discriminating prefix each format leaves, so an addition to either
/// helper is picked up uniformly.
pub fn sniff_content_type(head: &[u8]) -> &'static str {
    if looks_like_mp4(head) {
        "video/mp4"
    } else if head.len() >= 4 && &head[..4] == b"\x1A\x45\xDF\xA3" {
        // Matroska / WebM EBML header
        "video/webm"
    } else if head.len() >= 4 && &head[..4] == b"RIFF" {
        // Could be WAV, AVI, or any other RIFF container; we only claim
        // WAV when the next eight bytes confirm it.
        if head.len() >= 12 && &head[8..12] == b"WAVE" { "audio/wav" } else { "application/octet-stream" }
    } else if head.len() >= 8 && &head[..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if head.len() >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_detects_mp4_ftyp_box() {
        let mut mp4 = vec![0u8; 32];
        mp4[4..8].copy_from_slice(b"ftyp");
        mp4[8..12].copy_from_slice(b"isom");
        assert!(looks_like_mp4(&mp4));
    }

    #[test]
    fn sniff_rejects_too_short() {
        assert!(!looks_like_mp4(&[]));
        assert!(!looks_like_mp4(&[0u8; 11]));
    }

    #[test]
    fn sniff_rejects_random_bytes() {
        let bytes: Vec<u8> = (0..64).collect();
        assert!(!looks_like_mp4(&bytes));
    }

    #[test]
    fn sniff_detects_wav_matroska_png_jpeg() {
        let mut wav = vec![0u8; 12];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert!(looks_like_known_other(&wav));

        assert!(looks_like_known_other(&[0x1A, 0x45, 0xDF, 0xA3, 0, 0]));
        assert!(looks_like_known_other(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n']));
        assert!(looks_like_known_other(&[0xFF, 0xD8, 0xFF, 0xE0]));
    }

    #[test]
    fn sniff_content_type_per_format() {
        let mut mp4 = vec![0u8; 32];
        mp4[4..8].copy_from_slice(b"ftyp");
        assert_eq!(sniff_content_type(&mp4), "video/mp4");
        assert_eq!(sniff_content_type(&[0x1A, 0x45, 0xDF, 0xA3]), "video/webm");
        let mut wav = vec![0u8; 12];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert_eq!(sniff_content_type(&wav), "audio/wav");
        assert_eq!(sniff_content_type(&[0xFF, 0xD8, 0xFF]), "image/jpeg");
        assert_eq!(sniff_content_type(&[]), "application/octet-stream");
    }
}
