"""Restricted, stdin-only DOCX capture. Resource isolation, not a sandbox."""
import base64
import io
import json
import re
import stat
import struct
import sys
import zlib
import zipfile
from xml.parsers import expat
from typing import NoReturn

MIB = 1024 * 1024
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"


def fail(message) -> NoReturn:
    raise ValueError(message)


def name(ns, local):
    return ns + "|" + local


def safe_path(value):
    if (not value or len(value) > 512 or not value.isascii()
            or any(ord(c) < 33 or ord(c) == 127 for c in value)
            or any(c in value for c in "\\:%?#")
            or any(p in ("", ".", "..") for p in value.split("/"))):
        fail("Unsafe ZIP name or relationship target")
    return value


def parse_xml(data, budget):
    budget[0] += len(data)
    if len(data) > 4 * MIB or budget[0] > 8 * MIB:
        fail("XML byte budget exceeded")
    text = data.decode("utf-8-sig", errors="strict")
    declaration = re.match(r"<\?xml\s.*?\?>", text, re.S)
    if declaration:
        encoding = re.search(r"encoding\s*=\s*['\"]([^'\"]+)['\"]", declaration[0])
        if encoding and encoding[1].lower() != "utf-8":
            fail("XML must declare UTF-8")
    # Bound markup before Expat sees it (including unterminated tokens).
    if any(len(token) > 32768 for token in re.findall(r"<[^<]*?(?:>|$)", text)):
        fail("XML markup token budget exceeded")
    parser = expat.ParserCreate(namespace_separator="|")
    stack = []
    roots = []

    def forbidden(*_args) -> NoReturn:
        fail("Forbidden XML DTD, entity, or external reference")

    def start(tag, attrs):
        budget[1] += 1
        if (len(stack) >= 64 or budget[1] > 100000 or len(tag) > 1024
                or len(attrs) > 64 or any(len(k) > 1024 or len(v) > 8192 for k, v in attrs.items())):
            fail("XML structure budget exceeded")
        node = [tag, attrs, []]
        (stack[-1][2] if stack else roots).append(node)
        stack.append(node)

    def chars(value):
        if stack and value:
            stack[-1][2].append(value)

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda _tag: stack.pop()
    parser.CharacterDataHandler = chars
    parser.StartDoctypeDeclHandler = forbidden
    parser.EntityDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    parser.ProcessingInstructionHandler = forbidden
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.Parse(text.encode("utf-8"), True)
    if len(roots) != 1:
        fail("Invalid XML root")
    return roots[0]


def children(node):
    for child in node[2]:
        if isinstance(child, list):
            yield child
        elif child.strip():
            fail("Unexpected XML text")


def walk(node):
    yield node
    for child in node[2]:
        if isinstance(child, list):
            yield from walk(child)


def relationships(root, source, entries):
    if root[0] != name(REL, "Relationships"):
        fail("Invalid relationships namespace")
    result = {}
    allowed = {"officeDocument", "image", "styles", "settings", "webSettings", "fontTable",
               "theme", "numbering", "header", "footer", "footnotes", "endnotes", "comments",
               "extended-properties", "custom-properties"}
    for child in children(root):
        attrs = child[1]
        if child[0] != name(REL, "Relationship") or list(children(child)):
            fail("Invalid relationship element")
        if set(attrs) - {"Id", "Type", "Target", "TargetMode"}:
            fail("Unsupported relationship attributes")
        rid, kind, target = (attrs.get(k, "") for k in ("Id", "Type", "Target"))
        if not rid or len(rid) > 256 or rid in result or attrs.get("TargetMode", "Internal") != "Internal":
            fail("Duplicate, missing or external relationship")
        if not (kind in {R + "/" + k for k in allowed}
                or kind in {"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
                            "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"}):
            fail("Unsupported relationship type")
        target = safe_path(target)
        resolved = (source.rsplit("/", 1)[0] + "/" if "/" in source else "") + target
        if resolved not in entries:
            fail("Missing relationship target")
        result[rid] = (kind, resolved)
    return result


def capture(data):
    if not 0 < len(data) <= 20 * MIB:
        fail("DOCX input budget exceeded")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if not 0 < len(infos) <= 1000 or sum(i.file_size for i in infos) > 64 * MIB:
            fail("ZIP entry or expansion budget exceeded")
        entries = {}
        folded = set()
        for info in infos:
            path = safe_path(info.filename)
            mode = info.external_attr >> 16
            if (info.orig_filename != info.filename or path.lower() in folded
                    or info.is_dir() or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                    or info.flag_bits & ~0x800 or info.compress_type not in (0, 8)
                    or info.extract_version > 20 or info.file_size > 20 * MIB):
                fail("Unsupported or colliding ZIP entry")
            # Reject ZIP64 extras and other feature-bearing extra records.
            if info.extra:
                fail("ZIP extra fields are unsupported")
            folded.add(path.lower())
            header = data[info.header_offset:info.header_offset + 30]
            if len(header) != 30:
                fail("Truncated ZIP local header")
            sig, version, flags, method, _, _, crc, packed, size, namelen, extra = struct.unpack("<4s5H3I2H", header)
            if (sig != b"PK\x03\x04" or version > 20 or flags != info.flag_bits
                    or method != info.compress_type or crc != info.CRC or packed != info.compress_size
                    or size != info.file_size or extra):
                fail("ZIP local/central header mismatch or unsupported feature")
            start = info.header_offset + 30 + namelen
            compressed = data[start:start + packed]
            if len(compressed) != packed:
                fail("Truncated ZIP payload")
            if method == 8:
                inflater = zlib.decompressobj(-15)
                emitted = inflater.decompress(compressed, info.file_size + 1)
                if (len(emitted) != info.file_size or not inflater.eof
                        or inflater.unused_data or inflater.unconsumed_tail):
                    fail("ZIP actual expansion budget mismatch")
            elif packed != size:
                fail("ZIP stored size mismatch")
            with archive.open(info) as stream:
                value = stream.read(min(info.file_size, 20 * MIB) + 1)
                if len(value) != info.file_size or stream.read(1):
                    fail("ZIP emitted-byte budget mismatch")
            entries[path] = value
    for path in entries:
        if any(path.lower().startswith(other.lower() + "/") for other in entries):
            fail("Colliding ZIP file and directory names")
    required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
    if not required <= entries.keys():
        fail("Missing DOCX package parts")
    budget = [0, 0]
    xml = {p: parse_xml(v, budget) for p, v in entries.items()
           if p.lower().endswith((".xml", ".rels"))}
    types = xml["[Content_Types].xml"]
    if types[0] != name(CT, "Types"):
        fail("Invalid content types namespace")
    defaults, overrides = {}, {}
    for child in children(types):
        if list(children(child)):
            fail("Invalid content type child")
        if child[0] == name(CT, "Default") and set(child[1]) == {"Extension", "ContentType"}:
            key = child[1]["Extension"].lower()
            dest = defaults
            if not re.fullmatch(r"[a-z0-9]+", key):
                fail("Invalid content type extension")
        elif child[0] == name(CT, "Override") and set(child[1]) == {"PartName", "ContentType"}:
            part = child[1]["PartName"]
            if not part.startswith("/"):
                fail("Invalid content type part")
            key = safe_path(part[1:])
            dest = overrides
            if key not in entries:
                fail("Missing content type part")
        else:
            fail("Invalid content type declaration")
        content_type = child[1]["ContentType"]
        if key in dest or "macro" in content_type.lower() or "vba" in content_type.lower():
            fail("Duplicate or macro content type")
        dest[key] = content_type
    if overrides.get("word/document.xml") != MAIN:
        fail("Unsupported DOCX main content type")
    rels = {}
    for path, root in xml.items():
        if not path.endswith(".rels"):
            continue
        if path == "_rels/.rels":
            source = ""
        else:
            match = re.fullmatch(r"(.*/)?_rels/([^/]+)\.rels", path)
            if not match:
                fail("Invalid relationships part path")
            source = (match[1] or "") + match[2]
            if source not in entries:
                fail("Relationships source missing")
        rels[source] = relationships(root, source, entries)
    office = [v for v in rels[""].values() if v[0] == R + "/officeDocument"]
    if office != [(R + "/officeDocument", "word/document.xml")]:
        fail("Expected single supported office document")
    root = xml["word/document.xml"]
    if root[0] != name(W, "document"):
        fail("Unsupported document namespace")
    bodies = list(children(root))
    if len(bodies) != 1 or bodies[0][0] != name(W, "body"):
        fail("Expected main document body")
    forbidden_w = {"altChunk", "object", "pict", "txbxContent", "ins", "del", "moveFrom", "moveTo",
                   "subDoc", "contentPart", "fldSimple", "instrText", "fldChar", "sym", "sdt"}
    for node in walk(root):
        ns, local = node[0].split("|", 1) if "|" in node[0] else ("", node[0])
        if ns not in {W, A, PIC, WP} or (ns == W and local in forbidden_w):
            fail("Unsupported body construct or namespace")
    paragraphs = []

    def structure(node):
        local = node[0]
        if local == name(W, "p"):
            paragraphs.append(node)
            if len(paragraphs) > 5000:
                fail("Paragraph budget exceeded")
            return
        allowed = {
            name(W, "body"): {"p", "tbl", "sectPr"},
            name(W, "tbl"): {"tblPr", "tblGrid", "tr"},
            name(W, "tr"): {"trPr", "tc"},
            name(W, "tc"): {"tcPr", "p", "tbl"},
        }
        for child in children(node):
            if child[0] not in {name(W, k) for k in allowed[local]}:
                fail("Unsupported body or table structure")
            if child[0] in allowed or child[0] == name(W, "p"):
                structure(child)

    structure(bodies[0])
    result, assets = [], {}
    image_count = text_size = asset_size = 0
    doc_rels = rels.get("word/document.xml", {})
    drawing_tags = {
        WP: {"inline", "anchor", "extent", "effectExtent", "docPr", "cNvGraphicFramePr",
             "simplePos", "positionH", "positionV", "align", "posOffset", "wrapNone", "wrapSquare",
             "wrapTight", "wrapThrough", "wrapTopAndBottom", "wrapPolygon", "start", "lineTo"},
        A: {"graphic", "graphicData", "graphicFrameLocks", "blip", "stretch", "fillRect", "srcRect",
            "xfrm", "off", "ext", "prstGeom", "avLst", "picLocks"},
        PIC: {"pic", "nvPicPr", "cNvPr", "cNvPicPr", "blipFill", "spPr"},
    }
    for number, paragraph in enumerate(paragraphs, 1):
        text, images = [], []

        def drawing(node):
            nonlocal image_count, asset_size
            placements = list(children(node))
            if len(placements) != 1 or placements[0][0] not in {name(WP, "inline"), name(WP, "anchor")}:
                fail("Unsupported DrawingML placement")
            nodes = list(walk(placements[0]))
            for item in nodes:
                ns, local = item[0].split("|", 1)
                if local not in drawing_tags.get(ns, set()):
                    fail("Unsupported DrawingML picture construct")
            pics = [n for n in nodes if n[0] == name(PIC, "pic")]
            blips = [n for n in nodes if n[0] == name(A, "blip")]
            if len(pics) != 1 or len(blips) != 1 or not any(n is blips[0] for n in walk(pics[0])):
                fail("Expected single embedded DrawingML picture")
            rid = blips[0][1].get(name(R, "embed"), "")
            if name(R, "link") in blips[0][1] or not rid:
                fail("External or missing image relationship")
            relation = doc_rels.get(rid)
            if not relation or relation[0] != R + "/image":
                fail("Missing image relationship")
            path = relation[1]
            extension = path.rsplit(".", 1)[-1]
            media = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(extension)
            if (not path.startswith("word/media/") or not media
                    or overrides.get(path, defaults.get(extension)) != media):
                fail("Only original embedded PNG/JPEG/WebP parts are supported")
            image_count += 1
            if image_count > 100:
                fail("Image occurrence budget exceeded")
            if path not in assets:
                asset_size += len(entries[path])
                if asset_size > 20 * MIB:
                    fail("PNG bytes budget exceeded")
                assets[path] = base64.b64encode(entries[path]).decode("ascii")
            descriptions = [n[1].get("descr", "") for n in nodes if n[0] == name(WP, "docPr")]
            caption = next((d for d in descriptions if d), "Original embedded PNG" if extension == "png" else "Original embedded " + extension.upper())
            if len(caption.encode("utf-16-le")) // 2 > 2000:
                fail("Picture description budget exceeded")
            images.append({"asset": path, "caption": caption})

        def inline(node):
            tag = node[0]
            if tag == name(W, "t"):
                if any(isinstance(v, list) for v in node[2]):
                    fail("Invalid text element")
                text.extend(node[2])
            elif tag in {name(W, "tab"), name(W, "br"), name(W, "cr")}:
                if list(children(node)) or node[1].get(name(W, "type"), "textWrapping") != "textWrapping":
                    fail("Unsupported text break")
                text.append("\t" if tag == name(W, "tab") else "\n")
            elif tag == name(W, "drawing"):
                drawing(node)
            elif tag in {name(W, "pPr"), name(W, "rPr"), name(W, "bookmarkStart"), name(W, "bookmarkEnd"), name(W, "proofErr")}:
                # Properties cannot hide source-bearing text/pictures.
                if any(n[0] in {name(W, "t"), name(W, "drawing"), name(W, "p")} for n in walk(node)):
                    fail("Content in paragraph properties")
            elif tag in {name(W, "p"), name(W, "r")}:
                for child in children(node):
                    if child[0] == name(W, "p"):
                        fail("Nested paragraph")
                    inline(child)
            else:
                fail("Unsupported paragraph content")

        inline(paragraph)
        value = "".join(text)
        text_size += len(value.encode("utf-16-le")) // 2
        if text_size > 1000000:
            fail("Text budget exceeded")
        result.append({"paragraph": number, "text": value, "images": images})
    return {"paragraphs": result, "assets": assets}


if __name__ == "__main__":
    try:
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
            resource.setrlimit(resource.RLIMIT_AS, (384 * MIB, 384 * MIB))
        except ImportError:
            pass  # Parent timeout/output caps still apply where resource is unavailable.
        result = capture(sys.stdin.buffer.read(20 * MIB + 1))
        sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    except Exception as error:
        sys.stderr.write("Restricted DOCX rejected: " + str(error)[:1500])
        sys.exit(1)
