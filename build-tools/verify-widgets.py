#!/usr/bin/env python3
"""Check payloads, widget metadata and author identity, not signature cryptography."""
import argparse
import base64
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile

TIZEN = 'http://tizen.org/ns/widgets'
DS = 'http://www.w3.org/2000/09/xmldsig#'
GAME_MODE = 'http://samsung.com/tv/metadata/use.game.mode'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_widget(path, expected, author, force):
    with ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Duplicate ZIP entries')
        files = {name: archive.read(name) for name in names if not name.endswith('/')}
    config = ET.fromstring(files.pop('config.xml'))
    require(config.get('version') == expected.get('version'), 'Unexpected widget version')
    require(config.find(f'{{{TIZEN}}}application').attrib ==
            expected.find(f'{{{TIZEN}}}application').attrib, 'Unexpected application identity')
    mode = [item for item in config.findall(f'{{{TIZEN}}}metadata') if item.get('key') == GAME_MODE]
    require(len(mode) == (1 if force else 0), 'Incorrect ForceGM metadata')
    if force:
        require(mode[0].get('value') == 'true', 'Incorrect ForceGM value')
        config.remove(mode[0])
    for name in ('author-signature.xml', 'signature1.xml'):
        require(name in files, f'Missing {name}')
    signature = ET.fromstring(files.pop('author-signature.xml'))
    certificate = signature.find(f'.//{{{DS}}}X509Certificate')
    require(certificate is not None and certificate.text, 'Missing author certificate')
    require(base64.b64decode(certificate.text) == author, 'Unexpected author certificate')
    files.pop('signature1.xml')
    return files, config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('normal', type=Path)
    parser.add_argument('forcegm', type=Path)
    parser.add_argument('--config', type=Path, default=Path('res/config.xml'))
    parser.add_argument('--author-cert', type=Path, required=True, help='Expected public author certificate in DER format')
    args = parser.parse_args()
    expected = ET.parse(args.config).getroot()
    author = args.author_cert.read_bytes()
    require(bool(author), 'Expected author certificate is empty')
    normal_files, normal_config = read_widget(args.normal, expected, author, False)
    force_files, force_config = read_widget(args.forcegm, expected, author, True)
    require(normal_files == force_files, 'Variant payloads differ outside config and signatures')
    for config in (normal_config, force_config):
        for node in config.iter():
            if node.text and not node.text.strip():
                node.text = None
            if node.tail and not node.tail.strip():
                node.tail = None
    require(ET.tostring(normal_config) == ET.tostring(force_config), 'Variant configuration differs beyond Game Mode metadata')
    print('Widgets OK: version, application identity, expected author certificate and identical variant payloads.')


if __name__ == '__main__':
    main()
