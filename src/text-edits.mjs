import {copyWorkspaceJson, exactObject, requireFileContent, workspaceFailure} from './workspace-values.mjs';

/** Apply non-overlapping UTF-16 edits to one immutable text snapshot. No I/O. */
export function applyTextEdits(content, value) {
  requireFileContent(content);
  const edits = copyWorkspaceJson(value);
  if (!Array.isArray(edits) || edits.length > 500) throw workspaceFailure('invalid_request', 'Expected at most 500 text edits');
  const starts = [0], ends = [];
  for (const newline of content.matchAll(/\r\n|\r|\n/g)) { ends.push(newline.index); starts.push(newline.index + newline[0].length); }
  ends.push(content.length);
  function offset(position) {
    exactObject(position, ['line', 'character']);
    if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.line >= starts.length || position.character < 0 || position.character > ends[position.line] - starts[position.line]) throw workspaceFailure('invalid_request', 'Edit position is outside the document');
    const index = starts[position.line] + position.character;
    const before = content.charCodeAt(index - 1), after = content.charCodeAt(index);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) throw workspaceFailure('invalid_request', 'Edit position splits a Unicode character');
    return index;
  }
  const ordered = edits.map(edit => {
    exactObject(edit, ['range', 'text']); exactObject(edit.range, ['start', 'end']);
    const start = offset(edit.range.start), end = offset(edit.range.end);
    if (end < start) throw workspaceFailure('invalid_request', 'Edit range is reversed');
    return {start, end, text: requireFileContent(edit.text)};
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const parts = []; let cursor = 0, previousStart = -1;
  for (const edit of ordered) {
    if (edit.start < cursor || edit.start === previousStart) throw workspaceFailure('invalid_request', 'Text edits overlap or share an ambiguous insertion point');
    parts.push(content.slice(cursor, edit.start), edit.text); cursor = edit.end; previousStart = edit.start;
  }
  parts.push(content.slice(cursor));
  return requireFileContent(parts.join(''));
}

