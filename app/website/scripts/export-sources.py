"""Export the bibliography worksheet using Python's standard library.

Run from website with: python scripts/export-sources.py
The workbook is read only. The checked-in JSON is verified by sync-assets.mjs.
"""

import hashlib
import json
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

SITE_ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = SITE_ROOT.parent / "纹样库" / "侗族" / "_标注成果" / "03_标注数据" / "侗族80张纹样标注成果.xlsx"
OUTPUT = SITE_ROOT / "src" / "data" / "sources.json"
NAMESPACE = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RELATIONSHIP_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
FIELDS = {
    "来源编号": "id", "资料标题": "title", "作者／机构": "author", "年份": "year",
    "资料类型": "type", "链接": "url", "适用纹样／使用说明": "scope",
}


def column_number(reference):
    number = 0
    for letter in re.match(r"[A-Z]+", reference).group():
        number = number * 26 + ord(letter) - ord("A") + 1
    return number - 1


with zipfile.ZipFile(WORKBOOK) as archive:
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = ["".join(item.itertext()) for item in shared_root.findall("s:si", NAMESPACE)]
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    sheet = next(item for item in workbook.findall("s:sheets/s:sheet", NAMESPACE) if item.attrib["name"] == "资料来源")
    relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    target = next(item.attrib["Target"] for item in relationships if item.attrib["Id"] == sheet.attrib[RELATIONSHIP_ID])
    worksheet_path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
    worksheet = ElementTree.fromstring(archive.read(worksheet_path))
    rows = []
    for row in worksheet.findall("s:sheetData/s:row", NAMESPACE):
        cells = {}
        for cell in row.findall("s:c", NAMESPACE):
            value = cell.findtext("s:v", default="", namespaces=NAMESPACE)
            if cell.attrib.get("t") == "s":
                value = shared[int(value)]
            elif cell.attrib.get("t") == "inlineStr":
                value = "".join(cell.find("s:is", NAMESPACE).itertext())
            cells[column_number(cell.attrib["r"])] = value.strip()
        rows.append(cells)

headers = rows[0]
if set(FIELDS) - set(headers.values()):
    raise ValueError("资料来源工作表缺少必要列。")
sources = [
    {FIELDS[header]: row.get(column, "") for column, header in headers.items() if header in FIELDS}
    for row in rows[1:] if any(row.values())
]
if len({source["id"] for source in sources}) != len(sources):
    raise ValueError("资料来源编号重复。")
catalogue = {
    "workbook": WORKBOOK.relative_to(SITE_ROOT.parent).as_posix(),
    "worksheet": "资料来源",
    "workbookSha256": hashlib.sha256(WORKBOOK.read_bytes()).hexdigest(),
    "sources": sources,
}
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"已导出{len(sources)}条来源记录。")
