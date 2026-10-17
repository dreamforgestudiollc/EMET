export default function fieldnote(input) {
  const rows = input && Array.isArray(input.rows) ? input.rows : [];
  return { count: rows.length };
}
