//! Narrow XNB reader for glossary `Strings/*` dictionaries.
//!
//! This is intentionally not a general XNB parser. It accepts only XNA 4.0
//! content whose root object is `Dictionary<string, string>`, which covers the
//! official Stardew `Content/Strings/*.xnb` files and matching community
//! language-pack string dictionaries.

use std::collections::HashMap;
use std::path::Path;

use lzxd::{Lzxd, WindowSize};

const COMPRESSED_LZ4_MASK: u8 = 0x40;
const COMPRESSED_LZX_MASK: u8 = 0x80;
const HIDEF_MASK: u8 = 0x01;
const XNB_HEADER_SIZE: usize = 10;
const XNB_COMPRESSED_HEADER_SIZE: usize = 14;
const XNB_FRAME_SIZE: usize = 0x8000;
const MAX_XNB_SIZE: usize = 64 * 1024 * 1024;
const MAX_TYPE_READERS: usize = 256;
const MAX_ENTRIES: usize = 250_000;
const MAX_STRING_SIZE: usize = 1024 * 1024;

pub fn read_string_dictionary(path: &Path) -> Result<HashMap<String, String>, String> {
    let length = std::fs::metadata(path)
        .map_err(|error| format!("read XNB metadata: {error}"))?
        .len();
    if length > MAX_XNB_SIZE as u64 {
        return Err("XNB file exceeds the 64 MiB limit.".to_string());
    }
    let bytes = std::fs::read(path).map_err(|error| format!("read XNB: {error}"))?;
    read_string_dictionary_bytes(&bytes)
}

fn read_string_dictionary_bytes(bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    if bytes.len() > MAX_XNB_SIZE {
        return Err("XNB file exceeds the 64 MiB limit.".to_string());
    }
    let content = decode_content(bytes)?;
    parse_string_dictionary(&content)
}

fn decode_content(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < XNB_HEADER_SIZE {
        return Err("XNB file is too small.".to_string());
    }
    if &bytes[0..3] != b"XNB" {
        return Err("Invalid XNB magic.".to_string());
    }
    let version = bytes[4];
    if version != 5 {
        return Err(format!("Unsupported XNB version: {version}."));
    }
    let flags = bytes[5];
    let compressed_lzx = flags & COMPRESSED_LZX_MASK != 0;
    let compressed_lz4 = flags & COMPRESSED_LZ4_MASK != 0;
    if compressed_lzx && compressed_lz4 {
        return Err("Unsupported XNB compression flags.".to_string());
    }

    let mut reader = ByteReader::new(bytes);
    reader.skip(6)?;
    let file_size = reader.read_u32_le()? as usize;
    if file_size != bytes.len() {
        return Err("XNB file size header does not match file length.".to_string());
    }

    if compressed_lz4 {
        return Err("LZ4-compressed XNB files are not supported.".to_string());
    }
    if compressed_lzx {
        let decompressed_size = reader.read_u32_le()? as usize;
        if decompressed_size > MAX_XNB_SIZE {
            return Err("XNB decompressed content exceeds the 64 MiB limit.".to_string());
        }
        let compressed = bytes
            .get(XNB_COMPRESSED_HEADER_SIZE..)
            .ok_or_else(|| "Missing compressed XNB content.".to_string())?;
        return decompress_lzx(compressed, decompressed_size);
    }

    let content = bytes
        .get(XNB_HEADER_SIZE..)
        .ok_or_else(|| "Missing XNB content.".to_string())?;
    let _hidef = flags & HIDEF_MASK != 0;
    Ok(content.to_vec())
}

fn decompress_lzx(compressed: &[u8], decompressed_size: usize) -> Result<Vec<u8>, String> {
    if decompressed_size > MAX_XNB_SIZE {
        return Err("XNB decompressed content exceeds the 64 MiB limit.".to_string());
    }
    let mut reader = ByteReader::new(compressed);
    let mut decoder = Lzxd::new(WindowSize::KB64);
    let mut out = Vec::new();
    out.try_reserve_exact(decompressed_size)
        .map_err(|_| "Could not allocate XNB decompression buffer.".to_string())?;

    while out.len() < decompressed_size && reader.remaining() > 0 {
        let flag = reader.read_u8()?;
        let (frame_size, block_size) = if flag == 0xff {
            let frame_size = reader.read_u16_be()? as usize;
            let block_size = reader.read_u16_be()? as usize;
            (frame_size, block_size)
        } else {
            reader.rewind(1)?;
            (XNB_FRAME_SIZE, reader.read_u16_be()? as usize)
        };
        if frame_size == 0 || block_size == 0 {
            break;
        }
        if frame_size > 0x10000 || block_size > 0x10000 {
            return Err("Invalid XNB compressed block size.".to_string());
        }
        let chunk = reader.read_slice(block_size)?;
        let expected = frame_size.min(decompressed_size - out.len());
        let decompressed = decoder
            .decompress_next(chunk, expected)
            .map_err(|error| format!("decompress XNB LZX: {error}"))?;
        let new_len = out
            .len()
            .checked_add(decompressed.len())
            .ok_or_else(|| "XNB decompression size overflow.".to_string())?;
        if new_len > decompressed_size {
            return Err("XNB decompression exceeded its declared size.".to_string());
        }
        out.extend_from_slice(decompressed);
    }

    if out.len() != decompressed_size {
        return Err(format!(
            "XNB decompression ended at {} of {decompressed_size} bytes.",
            out.len()
        ));
    }
    Ok(out)
}

fn parse_string_dictionary(bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    let mut reader = ByteReader::new(bytes);
    let reader_count = reader.read_7bit_usize()?;
    if reader_count > MAX_TYPE_READERS {
        return Err("XNB has more than 256 type readers.".to_string());
    }
    let mut readers = Vec::new();
    readers
        .try_reserve_exact(reader_count)
        .map_err(|_| "Could not allocate XNB type-reader table.".to_string())?;
    for _ in 0..reader_count {
        let type_name = reader.read_string()?;
        let _version = reader.read_i32_le()?;
        readers.push(type_name);
    }
    if readers.is_empty() {
        return Err("XNB has no type readers.".to_string());
    }
    let shared_resources = reader.read_7bit_usize()?;
    if shared_resources != 0 {
        return Err("XNB shared resources are not supported.".to_string());
    }

    let dictionary_reader = reader.read_7bit_usize()?;
    let dictionary_type = reader_name(&readers, dictionary_reader)?;
    if !dictionary_type.contains("DictionaryReader") || !dictionary_type.contains("System.String") {
        return Err("XNB root is not a string dictionary.".to_string());
    }
    let string_reader = readers
        .iter()
        .position(|name| name.contains("StringReader"))
        .map(|index| index + 1)
        .ok_or_else(|| "XNB has no StringReader.".to_string())?;

    let count = reader.read_u32_le()? as usize;
    if count > MAX_ENTRIES {
        return Err("XNB string dictionary exceeds 250000 entries.".to_string());
    }
    if count > reader.remaining() / 2 {
        return Err("XNB string dictionary count exceeds the remaining data.".to_string());
    }
    let mut map = HashMap::new();
    map.try_reserve(count)
        .map_err(|_| "Could not allocate XNB string dictionary.".to_string())?;
    for _ in 0..count {
        let key = read_indexed_string(&mut reader, string_reader)?;
        let value = read_indexed_string(&mut reader, string_reader)?;
        map.insert(key, value);
    }
    Ok(map)
}

fn reader_name(readers: &[String], one_based_index: usize) -> Result<&str, String> {
    if one_based_index == 0 {
        return Err("XNB reader index 0 is null.".to_string());
    }
    readers
        .get(one_based_index - 1)
        .map(String::as_str)
        .ok_or_else(|| format!("Invalid XNB reader index: {one_based_index}."))
}

fn read_indexed_string(
    reader: &mut ByteReader<'_>,
    string_reader: usize,
) -> Result<String, String> {
    let index = reader.read_7bit_usize()?;
    if index == 0 {
        return Ok(String::new());
    }
    if index != string_reader {
        return Err(format!(
            "Expected StringReader index {string_reader}, got {index}."
        ));
    }
    reader.read_string()
}

struct ByteReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    fn skip(&mut self, len: usize) -> Result<(), String> {
        self.read_slice(len).map(|_| ())
    }

    fn rewind(&mut self, len: usize) -> Result<(), String> {
        self.pos = self
            .pos
            .checked_sub(len)
            .ok_or_else(|| "XNB reader rewind before start.".to_string())?;
        Ok(())
    }

    fn read_slice(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or_else(|| "XNB reader overflow.".to_string())?;
        let slice = self
            .bytes
            .get(self.pos..end)
            .ok_or_else(|| "Unexpected end of XNB data.".to_string())?;
        self.pos = end;
        Ok(slice)
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_slice(1)?[0])
    }

    fn read_u16_be(&mut self) -> Result<u16, String> {
        let bytes = self.read_slice(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn read_u32_le(&mut self) -> Result<u32, String> {
        let bytes = self.read_slice(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn read_i32_le(&mut self) -> Result<i32, String> {
        let bytes = self.read_slice(4)?;
        Ok(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn read_7bit_usize(&mut self) -> Result<usize, String> {
        let mut result = 0usize;
        let mut shift = 0usize;
        loop {
            if shift >= usize::BITS as usize {
                return Err("Invalid 7-bit encoded integer.".to_string());
            }
            let byte = self.read_u8()?;
            result |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
        }
    }

    fn read_string(&mut self) -> Result<String, String> {
        let len = self.read_7bit_usize()?;
        if len > MAX_STRING_SIZE {
            return Err("XNB string exceeds the 1 MiB limit.".to_string());
        }
        let bytes = self.read_slice(len)?;
        String::from_utf8(bytes.to_vec())
            .map_err(|error| format!("XNB string is not UTF-8: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_7bit(out: &mut Vec<u8>, mut value: usize) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn write_string(out: &mut Vec<u8>, text: &str) {
        write_7bit(out, text.len());
        out.extend_from_slice(text.as_bytes());
    }

    fn wrap_uncompressed(content: &[u8]) -> Vec<u8> {
        let mut xnb = Vec::new();
        xnb.extend_from_slice(b"XNBw");
        xnb.push(5);
        xnb.push(HIDEF_MASK);
        xnb.extend_from_slice(&0u32.to_le_bytes());
        xnb.extend_from_slice(content);
        let len = xnb.len() as u32;
        xnb[6..10].copy_from_slice(&len.to_le_bytes());
        xnb
    }

    fn dictionary_prefix(count: u32) -> Vec<u8> {
        let mut content = Vec::new();
        write_7bit(&mut content, 2);
        write_string(
            &mut content,
            "Microsoft.Xna.Framework.Content.DictionaryReader`2[[System.String, mscorlib],[System.String, mscorlib]]",
        );
        content.extend_from_slice(&0i32.to_le_bytes());
        write_string(&mut content, "Microsoft.Xna.Framework.Content.StringReader");
        content.extend_from_slice(&0i32.to_le_bytes());
        write_7bit(&mut content, 0);
        write_7bit(&mut content, 1);
        content.extend_from_slice(&count.to_le_bytes());
        content
    }

    fn test_xnb_dictionary(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut content = dictionary_prefix(entries.len() as u32);
        for (key, value) in entries {
            write_7bit(&mut content, 2);
            write_string(&mut content, key);
            write_7bit(&mut content, 2);
            write_string(&mut content, value);
        }

        wrap_uncompressed(&content)
    }

    #[test]
    fn reads_uncompressed_string_dictionary() {
        let bytes = test_xnb_dictionary(&[("Spring", "Frühling"), ("Parsnip", "Pastinake")]);
        let map = read_string_dictionary_bytes(&bytes).unwrap();
        assert_eq!(map.get("Spring").map(String::as_str), Some("Frühling"));
        assert_eq!(map.get("Parsnip").map(String::as_str), Some("Pastinake"));
    }

    #[test]
    fn rejects_oversized_file_before_reading_it() {
        let dir = crate::test_support::temp_dir("xnb-oversized-file");
        let path = dir.join("large.xnb");
        std::fs::create_dir_all(&dir).unwrap();
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_XNB_SIZE as u64 + 1).unwrap();
        assert!(read_string_dictionary(&path)
            .unwrap_err()
            .contains("64 MiB"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_oversized_declared_decompression() {
        let mut bytes = b"XNBw".to_vec();
        bytes.push(5);
        bytes.push(COMPRESSED_LZX_MASK);
        bytes.extend_from_slice(&(XNB_COMPRESSED_HEADER_SIZE as u32).to_le_bytes());
        bytes.extend_from_slice(&((MAX_XNB_SIZE + 1) as u32).to_le_bytes());
        assert!(read_string_dictionary_bytes(&bytes)
            .unwrap_err()
            .contains("decompressed"));
    }

    #[test]
    fn rejects_excessive_reader_entry_and_string_counts() {
        let mut readers = Vec::new();
        write_7bit(&mut readers, MAX_TYPE_READERS + 1);
        assert!(read_string_dictionary_bytes(&wrap_uncompressed(&readers))
            .unwrap_err()
            .contains("type readers"));

        let entries = wrap_uncompressed(&dictionary_prefix((MAX_ENTRIES + 1) as u32));
        assert!(read_string_dictionary_bytes(&entries)
            .unwrap_err()
            .contains("250000"));

        let mut string = dictionary_prefix(1);
        write_7bit(&mut string, 2);
        write_7bit(&mut string, MAX_STRING_SIZE + 1);
        assert!(read_string_dictionary_bytes(&wrap_uncompressed(&string))
            .unwrap_err()
            .contains("1 MiB"));
    }

    #[test]
    fn truncated_dictionary_returns_an_error() {
        let mut bytes = test_xnb_dictionary(&[("key", "value")]);
        bytes.pop();
        let len = bytes.len() as u32;
        bytes[6..10].copy_from_slice(&len.to_le_bytes());
        assert!(read_string_dictionary_bytes(&bytes).is_err());
    }
}
