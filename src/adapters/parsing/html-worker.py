"""Restricted structural HTML, not browser rendering. No resource access."""
import json
import sys
from html.parser import HTMLParser

MAX_SOURCE = 20 * 1024 * 1024
BLOCKS = set('h1 h2 h3 h4 h5 h6 p li td th caption'.split())
WRAPPERS = set('html head body div section article main header footer nav ul ol table thead tbody tfoot tr'.split())
INLINE = set('span a b strong i em u s small sub sup code'.split())
VOID = {'img', 'br', 'meta', 'hr'}


def valid_text(value):
    if any((ord(c) < 32 and c not in '\t\n\r') or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError('Invalid HTML control or Unicode')
    return value


class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.blocks = []
        self.current = None
        self.count = 0
        self.size = 0
        self.images = 0

    def block(self):
        if self.current is None:
            if len(self.blocks) >= 5000:
                raise ValueError('HTML block budget exceeded')
            self.current = {'tag': next((t for t in reversed(self.stack) if t in BLOCKS), 'text'), 'text': [], 'images': []}
            self.blocks.append(self.current)
        return self.current

    def handle_starttag(self, tag, attrs):
        self.count += 1
        if self.count > 20000 or len(self.stack) >= 64 or len(attrs) > 32:
            raise ValueError('HTML nesting/tag/attribute budget exceeded')
        if tag not in BLOCKS | WRAPPERS | INLINE | VOID:
            raise ValueError('Unsupported HTML tag: ' + tag)
        values = {}
        for key, value in attrs:
            if key in values or value is None or len(value) > 4096:
                raise ValueError('Invalid HTML attribute')
            valid_text(value)
            allowed = {'id', 'lang', 'dir', 'title'} | ({'src', 'alt', 'width', 'height'} if tag == 'img' else set()) | ({'href'} if tag == 'a' else set()) | ({'charset'} if tag == 'meta' else set()) | ({'colspan', 'rowspan', 'scope'} if tag in {'td', 'th'} else set())
            if key not in allowed:
                raise ValueError('Unsupported HTML attribute: ' + key)
            values[key] = value
        if tag == 'meta' and (set(values) != {'charset'} or values['charset'].lower() not in {'utf-8', 'utf8'}):
            raise ValueError('Only UTF-8 charset metadata supported')
        if 'head' in self.stack and tag != 'meta':
            raise ValueError('Only charset metadata supported in head')
        if tag in BLOCKS | WRAPPERS:
            if any(t in BLOCKS | INLINE for t in self.stack):
                raise ValueError('Ambiguous HTML block nesting')
            self.current = None
        if tag == 'img':
            if not values.get('src') or len(values.get('alt', '')) > 2000:
                raise ValueError('HTML image requires src and bounded alt')
            self.images += 1
            if self.images > 100:
                raise ValueError('HTML image budget exceeded')
            self.block()['images'].append({'src': values['src'], 'caption': values.get('alt', '')})
        elif tag == 'br':
            self.handle_data(' ')
        elif tag == 'hr':
            self.current = None
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag not in VOID:
            raise ValueError('Nonvoid self-closing HTML unsupported')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1] != tag:
            raise ValueError('Mismatched HTML closing tag')
        self.stack.pop()
        if tag in BLOCKS | WRAPPERS:
            self.current = None

    def handle_data(self, data):
        valid_text(data)
        self.size += len(data.encode('utf-16-le')) // 2
        if self.size > 1000000:
            raise ValueError('HTML text budget exceeded')
        if 'head' in self.stack:
            if data.strip():
                raise ValueError('Unsupported head text')
            return
        if data.strip() or self.current is not None:
            self.block()['text'].append(data)

    def handle_decl(self, decl):
        if decl.lower() != 'doctype html':
            raise ValueError('Unsupported HTML declaration')

    def unknown_decl(self, data):
        raise ValueError('Unsupported HTML declaration')

    def handle_pi(self, data):
        raise ValueError('Unsupported HTML processing instruction')


try:
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    except (ImportError, OSError, ValueError):
        print('Optional OS resource limits unavailable; parent wall/output limits remain active', file=sys.stderr)
    source = sys.stdin.buffer.read(MAX_SOURCE + 1)
    if not source or len(source) > MAX_SOURCE:
        raise ValueError('HTML source budget exceeded')
    text = valid_text(source.decode('utf-8-sig', errors='strict'))
    parser = Parser()
    parser.feed(text)
    # HTMLParser otherwise turns incomplete markup into ordinary text at close.
    if parser.rawdata:
        raise ValueError('Incomplete HTML token')
    parser.close()
    if parser.stack:
        raise ValueError('Unclosed HTML tags')
    for block in parser.blocks:
        block['text'] = ' '.join(''.join(block['text']).split())
    print(json.dumps({'blocks': parser.blocks}, ensure_ascii=True, separators=(',', ':')))
except Exception as error:
    print(str(error)[:1000], file=sys.stderr)
    sys.exit(1)
