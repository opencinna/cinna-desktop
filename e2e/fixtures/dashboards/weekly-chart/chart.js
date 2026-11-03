// A bar chart with no library: the data arrives through window.cinna, which
// the host injects. The page never fetches its data itself.
function draw(data, meta) {
  var svg = document.getElementById('chart')
  var points = (data && data.points) || []
  var max = Math.max.apply(null, points.map(function (p) { return p.value }).concat([1]))
  var width = 280 / Math.max(points.length, 1)
  svg.innerHTML = ''
  points.forEach(function (p, i) {
    var h = (p.value / max) * 100
    var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    rect.setAttribute('x', String(i * width + 4))
    rect.setAttribute('y', String(105 - h))
    rect.setAttribute('width', String(width - 8))
    rect.setAttribute('height', String(h))
    rect.setAttribute('data-day', p.day)
    svg.appendChild(rect)
    var label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('x', String(i * width + width / 2))
    label.setAttribute('y', '118')
    label.setAttribute('text-anchor', 'middle')
    label.textContent = p.day
    svg.appendChild(label)
  })
  document.getElementById('title').textContent = (data && data.title) || 'Signups'
  document.getElementById('state').textContent = meta && meta.stale ? 'Cached — refreshing…' : 'Fresh'
}

window.cinna.ready.then(function (info) {
  document.title = info.title || 'Chart'
})
window.cinna.onData(draw)
