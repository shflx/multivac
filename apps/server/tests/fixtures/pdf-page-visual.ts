/** 两页真实 PDF：内嵌 RGB 图片、向量柱图、表格及上标公式，供原页视觉验收。 */
export function visualPdf(withText = true): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, label] of ['First', 'Second'].entries()) {
    let content = `BT /F1 18 Tf 40 750 Td (${label} PDF layout) Tj ET
q 120 0 0 100 40 540 cm /Image1 Do Q
0 0.4 0.9 rg 250 540 40 100 re f 310 540 40 60 re f
0 0 0 RG 40 390 400 60 re S 40 420 m 440 420 l S 240 390 m 240 450 l S
0 0 0 rg BT /F1 14 Tf 40 480 Td (E = mc) Tj /F1 9 Tf 3 Ts (2) Tj ET
BT /F1 12 Tf 50 430 Td (Table A) Tj ET BT /F1 12 Tf 250 430 Td (Table B) Tj ET`;
    if (!withText) content = content.replace(/BT[\s\S]*?ET/gu, '');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /Image1 8 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  const image = 'ff000000ff000000ffffffff>';
  objects.push(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`);
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
