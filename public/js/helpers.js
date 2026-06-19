function $(id) { return document.getElementById(id) }
function setText(id, txt) { $(id).innerText = txt }
function show(el) { $(el).style.display = '' }
function hide(el) { $(el).style.display = 'none' }
function val(id) { return $(id).value }
function setVal(id, v) { $(id).value = v }
function on(id, ev, fn) { $(id).addEventListener(ev, fn) }
function qs(sel) { return document.querySelector(sel) }
function qsa(sel) { return document.querySelectorAll(sel) }

function enable(id) { $(id).disabled = false }
function disable(id) { $(id).disabled = true }

function addClass(id, cls) { $(id).classList.add(cls) }
function rmClass(id, cls) { $(id).classList.remove(cls) }
function toggleClass(id, cls) { $(id).classList.toggle(cls) }
