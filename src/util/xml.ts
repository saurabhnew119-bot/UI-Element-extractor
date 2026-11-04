/**
 * Minimal XML parser for Appium page sources and JUnit reports. Both are machine-generated, well-formed
 * documents, so we only need elements, attributes, and entity decoding; text nodes are ignored.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return NAMED[e];
  });
}

export function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(xml: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('Unterminated XML comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end < 0) throw new Error('Unterminated CDATA section');
      i = end + 3;
      continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw new Error('Unterminated XML declaration');
      i = end + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    if (gt < 0) throw new Error(`Unterminated tag at offset ${lt}`);
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Mismatched closing tag </${name}>`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^[^\s/>]+/.exec(inner);
    if (!nameMatch) throw new Error(`Invalid tag at offset ${lt}`);
    const el: XmlElement = { name: nameMatch[0], attrs: {}, children: [] };
    for (const m of inner.slice(nameMatch[0].length).matchAll(ATTR_RE)) {
      el.attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    else throw new Error('XML document has more than one root element');
    if (!selfClosing) stack.push(el);
  }
  if (!root) throw new Error('XML document has no root element');
  if (stack.length) throw new Error(`Unclosed tag <${stack[stack.length - 1].name}>`);
  return root;
}

/** Finds the closing '>' of a tag, skipping '>' characters inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let j = from + 1; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j;
    }
  }
  return -1;
}
