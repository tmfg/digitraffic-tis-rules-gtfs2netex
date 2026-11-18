import { Document, DOMParser, Node as XmlNode, XMLSerializer } from '@xmldom/xmldom';

export function parse(xml: string): Document {
    return new DOMParser().parseFromString(xml, 'text/xml');
}

export function removeWhitespaceOnlyText(node: XmlNode): void {
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === child.TEXT_NODE && (child.nodeValue ?? '').trim() === '') {
            node.removeChild(child);
        } else {
            removeWhitespaceOnlyText(child);
        }
    }
}

// Serializes the XML after dropping whitespace-only text, so documents that differ only in formatting compare equal.
export function canonical(xml: string): string {
    const doc = parse(xml);
    removeWhitespaceOnlyText(doc);
    return new XMLSerializer().serializeToString(doc);
}
