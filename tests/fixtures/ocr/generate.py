"""Host fixture helper, offline: requires Pillow, ReportLab and a trusted Chinese font.
Usage: python3 generate.py /absolute/wqy-zenhei.ttc
Produces authored public synthetic documents only, not OCR implementation mocks.
"""
import sys
from pathlib import Path
# Dependencies intentionally live in the host-selected external stack, not this project.
from PIL import Image, ImageDraw, ImageFont  # pyright: ignore[reportMissingImports]
from reportlab.pdfgen import canvas
out = Path(__file__).parent
image = Image.new('RGB', (2480, 3508), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype(sys.argv[1], 78)
draw.text((180, 350), 'Knowledge retrieval preserves original images.', font=font, fill='black')
draw.text((180, 530), '知识检索保留原始图片', font=font, fill='black')
image.save(out / 'bilingual.png')
def make(name, pages):
    c = canvas.Canvas(str(out / name), pagesize=(595.2, 841.92), invariant=1)
    for kind in pages:
        if kind in ['scan', 'overlay']:
            c.drawImage(str(out / 'bilingual.png'), 0, 0, width=595.2, height=841.92)
        if kind in ['native', 'overlay']:
            c.setFont('Helvetica', 20)
            c.drawString(50, 60 if kind == 'overlay' else 600, 'Native evidence page 1')
        c.showPage()
    c.save()
make('bilingual-scanned.pdf', ['scan'])
make('mixed.pdf', ['native', 'scan', 'overlay'])
make('blank.pdf', ['scan', 'blank'])
make('native.pdf', ['native'])
(out / 'bilingual.png').unlink()
