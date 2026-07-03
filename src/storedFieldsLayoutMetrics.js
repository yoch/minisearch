export function storedFieldsJsonBytes(layout) {
  if (layout.kind === 'none') return 0
  if (layout.kind === 'multi') {
    let total = 0
    for (const row of layout.rows) {
      if (row != null) total += JSON.stringify(row).length
    }
    return total
  }

  let total = 0
  const { field, values } = layout
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value !== undefined) total += JSON.stringify({ [field]: value }).length
  }
  return total
}

export function storedFieldsSlotCount(layout) {
  if (layout.kind === 'none') return 0
  return layout.kind === 'single' ? layout.values.length : layout.rows.length
}
