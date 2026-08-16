/**
 * Local bootstrap page. Normally the main process loads the Harness URL
 * directly; this page is only shown when the child process fails to start,
 * with the failure text passed in the `error` query parameter.
 */

const params = new URLSearchParams(window.location.search)
const error = params.get('error')
const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')

if (error !== null && error !== '') {
  document.title = 'DeepSeek Harness — failed to start'
  if (statusEl !== null) statusEl.textContent = 'DeepSeek Harness could not start.'
  if (errorEl !== null) {
    errorEl.hidden = false
    errorEl.textContent = error
  }
} else if (statusEl !== null) {
  statusEl.textContent = 'DeepSeek Harness is starting…'
}
