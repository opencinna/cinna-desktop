// Signups per day: params JSON on stdin, one JSON value on stdout.
// Runs with the user's node, or Cinna's own runtime when there is none.
const input = await new Response(process.stdin).text()
const params = input.trim() ? JSON.parse(input) : {}
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const values = [12, 19, 7, 24, 16, 9, 21]
console.log(JSON.stringify({ title: 'Signups this week', points: days.map((day, i) => ({ day, value: values[i] })), params }))
