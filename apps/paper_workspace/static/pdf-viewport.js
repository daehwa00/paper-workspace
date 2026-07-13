(() => {
  const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum)

  function viewportBounds(panel) {
    const panelRect = panel.getBoundingClientRect()
    const headerRect = panel.querySelector('.preview-header')?.getBoundingClientRect()
    const top = Math.max(panelRect.top, headerRect?.bottom || panelRect.top)
    const bottom = Math.min(panelRect.bottom, innerHeight)
    return { top, bottom, center: (top + bottom) / 2 }
  }

  function currentPage(panel, pages = panel.querySelectorAll('.pdf-page')) {
    const candidates = Array.from(pages)
    if (!candidates.length) return null
    const { top, bottom, center } = viewportBounds(panel)
    let current = candidates[0]
    let bestVisible = -1
    let bestDistance = Infinity
    for (const page of candidates) {
      const rect = page.getBoundingClientRect()
      const visible = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top))
      const distance = Math.abs((rect.top + rect.bottom) / 2 - center)
      if (visible > bestVisible || (visible === bestVisible && distance < bestDistance)) {
        current = page
        bestVisible = visible
        bestDistance = distance
      }
    }
    return current
  }

  function capture(panel, pages = panel.querySelectorAll('.pdf-page')) {
    const current = currentPage(panel, pages)
    if (!current) return null
    const rect = current.getBoundingClientRect()
    const { center } = viewportBounds(panel)
    const horizontalRange = panel.scrollWidth - panel.clientWidth
    return {
      pageNumber: Number(current.dataset.page) || 1,
      pageProgress: rect.height > 0 ? clamp((center - rect.top) / rect.height, 0, 1) : 0,
      horizontalProgress: horizontalRange > 0 ? panel.scrollLeft / horizontalRange : 0
    }
  }

  function restore(panel, pages, snapshot) {
    const candidates = Array.from(pages)
    if (!snapshot || !candidates.length) return candidates[0] || null
    const index = clamp((Number(snapshot.pageNumber) || 1) - 1, 0, candidates.length - 1)
    const target = candidates[index]
    const rect = target.getBoundingClientRect()
    const { center } = viewportBounds(panel)
    const progress = clamp(Number(snapshot.pageProgress) || 0, 0, 1)
    panel.scrollTop += rect.top + rect.height * progress - center
    const horizontalRange = panel.scrollWidth - panel.clientWidth
    panel.scrollLeft = clamp(Number(snapshot.horizontalProgress) || 0, 0, 1) * Math.max(0, horizontalRange)
    return target
  }

  window.PaperPdfViewport = Object.freeze({ capture, currentPage, restore })
})()
