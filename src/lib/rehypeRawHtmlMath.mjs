import katex from 'katex';

const PROTECTED_HTML_SEGMENT =
  /(<!--[\s\S]*?-->|<(?:code|pre|script|style|svg|textarea)\b[^>]*>[\s\S]*?<\/(?:code|pre|script|style|svg|textarea)>|<[^>]+>)/gi;

function decodeHtmlEntitiesInMath(tex) {
  return tex
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderMathInTextSegment(text) {
  if (!text.includes('$')) {
    return text;
  }

  const withDisplay = text.replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (_match, rawTex) =>
    katex.renderToString(decodeHtmlEntitiesInMath(rawTex.trim()), {
      displayMode: true,
      throwOnError: true,
    })
  );

  return withDisplay.replace(/(?<!\\)\$([^\$\n]+?)(?<!\\)\$/g, (_match, rawTex) =>
    katex.renderToString(decodeHtmlEntitiesInMath(rawTex.trim()), {
      displayMode: false,
      throwOnError: true,
    })
  );
}

export function renderMathInRawHtml(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml.includes('$')) {
    return rawHtml;
  }

  let output = '';
  let lastIndex = 0;
  PROTECTED_HTML_SEGMENT.lastIndex = 0;

  let match;
  while ((match = PROTECTED_HTML_SEGMENT.exec(rawHtml)) !== null) {
    if (match.index > lastIndex) {
      output += renderMathInTextSegment(rawHtml.slice(lastIndex, match.index));
    }
    output += match[0];
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < rawHtml.length) {
    output += renderMathInTextSegment(rawHtml.slice(lastIndex));
  }

  return output;
}

export default function rehypeRawHtmlMath() {
  return function transform(tree) {
    function visit(node) {
      if (node.type === 'raw' && typeof node.value === 'string') {
        node.value = renderMathInRawHtml(node.value);
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(child);
        }
      }
    }
    visit(tree);
  };
}
