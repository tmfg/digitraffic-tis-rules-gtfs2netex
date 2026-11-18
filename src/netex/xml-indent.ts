import { Document, Element, Node } from '@xmldom/xmldom';

const INDENT = '  ';

const MAX_INDENTED_CHILDREN = 10_000;

/**
 * Indents the document by inserting whitespace text nodes, two spaces per level and LF line breaks.
 *
 * Only elements whose children are all elements are indented. An element with any other child (text,
 * whitespace-only text, comment, CDATA, processing instruction) is left untouched, so leaf text and
 * mixed content are written exactly as they are. An element with more than {@link MAX_INDENTED_CHILDREN}
 * children is left unindented together with its whole subtree, because xmldom inserts in quadratic time.
 * Mutates the document in place.
 */
function indentDocument(doc: Document): void {
    if (doc.documentElement) {
        indentElement(doc.documentElement, 0);
    }
}

/**
 * Indents the content of an element that is, or will be, written at the given depth (two spaces per level).
 *
 * The children go one level deeper and the closing tag at the element's own depth. The opening tag gets no
 * indent here, so the caller writes it at the right depth. Same rules as {@link indentDocument}.
 */
function indentElement(element: Element, depth: number): void {
    indentChildren(element, depth);
}

/** A line break followed by the indent for the given depth. */
function lineBreakAt(depth: number): string {
    return '\n' + INDENT.repeat(depth);
}

function indentChildren(parent: Element, depth: number): void {
    const children: Element[] = [];
    for (let child = parent.firstChild; child; child = child.nextSibling) {
        // Any non-element child (text, comment, ...) means the content is written exactly as it is
        if (child.nodeType !== Node.ELEMENT_NODE) {
            return;
        }
        children.push(child as Element);
        if (children.length > MAX_INDENTED_CHILDREN) {
            return;
        }
    }
    // No children: nothing to indent, the element stays self-closing
    if (children.length === 0) {
        return;
    }

    const doc = parent.ownerDocument;
    if (!doc) {
        throw new Error(`Element ${parent.nodeName} does not belong to a document`);
    }
    const childIndent = lineBreakAt(depth + 1);
    for (const child of children) {
        parent.insertBefore(doc.createTextNode(childIndent), child);
        indentChildren(child, depth + 1);
    }
    parent.appendChild(doc.createTextNode(lineBreakAt(depth)));
}

export { indentDocument, indentElement, INDENT, MAX_INDENTED_CHILDREN };
