// Minimal uncompressed XNB Dictionary<string,string>, matching the format
// exercised by src-tauri/src/glossary.rs. All text is synthetic; no game assets.
export function xnbDictionary(entries) {
  const bytes = [];
  const integer = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    bytes.push(...buffer);
  };
  const sevenBit = (value) => {
    while (value >= 128) {
      bytes.push((value & 127) | 128);
      value >>>= 7;
    }
    bytes.push(value);
  };
  const string = (text) => {
    const buffer = Buffer.from(text, "utf8");
    sevenBit(buffer.length);
    bytes.push(...buffer);
  };
  sevenBit(2);
  string(
    "Microsoft.Xna.Framework.Content.DictionaryReader`2[[System.String, mscorlib],[System.String, mscorlib]]",
  );
  integer(0);
  string("Microsoft.Xna.Framework.Content.StringReader");
  integer(0);
  sevenBit(0);
  sevenBit(1);
  integer(Object.keys(entries).length);
  for (const [key, value] of Object.entries(entries)) {
    sevenBit(2);
    string(key);
    sevenBit(2);
    string(value);
  }
  const header = Buffer.from([88, 78, 66, 119, 5, 1, 0, 0, 0, 0]);
  header.writeUInt32LE(10 + bytes.length, 6);
  return Buffer.concat([header, Buffer.from(bytes)]);
}
