// Everything that writes to the results panel, the stat tiles or the toast.
//
// Every function takes the document (and its data) as arguments and reads no
// module-level state, so a test can render an arbitrary list into a real
// index.html without booting a scan.
import { pingClass } from './format.js';

// Safe DOM only: server/port come from user-pasted URLs, so text goes in through
// textContent -- never innerHTML here. The node check is duck-typed rather than
// `instanceof Node` so the function does not depend on a global.
export function resultCell(doc, className, content) {
    const td = doc.createElement('td');
    if (className) td.className = className;
    if (content && typeof content === 'object' && typeof content.nodeType === 'number') td.appendChild(content);
    else td.textContent = content;
    return td;
}

export function renderResultsTable(doc, proxies, rowCopyLabel) {
    const tbody = doc.getElementById('resultsBody');
    const frag = doc.createDocumentFragment();
    proxies.forEach((p, i) => {
        const badge = doc.createElement('span');
        badge.className = 'ping ' + pingClass(p.ping);
        badge.textContent = p.ping + ' ms';

        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'rowcopy';
        btn.dataset.index = i;
        btn.textContent = rowCopyLabel;

        const tr = doc.createElement('tr');
        // Attribution rides the row as data, not as text: a pasted proxy has none, and
        // the ids are positions in the snapshot's source table, not anything to display.
        if (p.srcs) tr.dataset.srcs = p.srcs.join(',');
        tr.append(
            resultCell(doc, 'rank', i + 1),
            resultCell(doc, 'host', p.server),
            resultCell(doc, 'host', p.port),
            resultCell(doc, null, badge),
            resultCell(doc, null, btn)
        );
        frag.appendChild(tr);
    });
    tbody.replaceChildren(frag);
    doc.getElementById('resultsCount').textContent = proxies.length;
    doc.getElementById('resultsPanel').classList.toggle('has-results', proxies.length > 0);
}

// best is the lowest ping found so far, or null when nothing works yet.
export function renderStats(doc, { checked, total, working, best, skipped }) {
    doc.getElementById('tileChecked').textContent = checked;
    doc.getElementById('tileTotal').textContent = total;
    doc.getElementById('tileWorking').textContent = working;
    doc.getElementById('tileBest').textContent = best === null || best === undefined ? '—' : best + ' ms';
    doc.getElementById('tileFailed').textContent = Math.max(0, checked - working);
    doc.getElementById('tileSkipped').textContent = skipped;
}

export function setResultsView(doc, view) {
    doc.getElementById('resultsPanel').dataset.view = view;
    doc.getElementById('viewTableBtn').setAttribute('aria-pressed', String(view === 'table'));
    doc.getElementById('viewTextBtn').setAttribute('aria-pressed', String(view === 'text'));
}

export function showToast(doc, message, isError = false) {
    const toast = doc.getElementById('toast');
    toast.innerText = message;
    toast.className = 'toast show ' + (isError ? 'error' : 'success');
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}
