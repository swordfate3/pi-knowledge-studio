export function fixture(texts: string[], bitmap = false, fontSize = "12"): Buffer {
  const objects: Buffer[] = [];
  const add = (text: string) => objects.push(Buffer.from(text, "latin1"));
  const imageId = 4 + texts.length * 2;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(
    `<< /Type /Pages /Count ${texts.length} /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
  );
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [index, text] of texts.entries()) {
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> ${bitmap ? `/XObject << /Im1 ${imageId} 0 R >>` : ""} >> /Contents ${5 + index * 2} 0 R >>`,
    );
    const stream = `${text ? `BT /F1 ${fontSize} Tf 20 200 Td (${text}) Tj ET\n` : ""}${bitmap ? "q 20 0 0 20 20 20 cm /Im1 Do Q\n" : ""}`;
    add(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  if (bitmap)
    add(
      "<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 6 >>\nstream\n\xff\x00\x00\x00\xff\x00\nendstream",
    );
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
