// Every on-screen window in the guest's login session, one per line:
// owner <TAB> pid <TAB> layer <TAB> WxH. Run with `osascript -l JavaScript`.
//
// JXA because a bare Mac has nothing else that can call CoreGraphics — its
// python3 is itself a developer-tool stub. Owner names need no Screen
// Recording permission (window titles would), which is all the nag check needs:
// a system dialog is a window whose owner is not the app or the desktop.
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
const list = ObjC.castRefToObject(
  $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)
)
const out = []
for (let i = 0; i < list.count; i++) {
  const w = list.objectAtIndex(i)
  const bounds = ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds'))
  out.push(
    [
      ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')),
      ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')),
      ObjC.unwrap(w.objectForKey('kCGWindowLayer')),
      `${Math.round(bounds.Width)}x${Math.round(bounds.Height)}`
    ].join('\t')
  )
}
out.join('\n')
