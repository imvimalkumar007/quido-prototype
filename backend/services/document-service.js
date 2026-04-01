'use strict';

function pickValue() {
  for (var i = 0; i < arguments.length; i++) {
    var val = arguments[i];
    if (val !== undefined && val !== null) return val;
  }
  return '';
}

function fmtCurrency(amount) {
  var value = Number(amount || 0);
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function fmtDate(value) {
  if (!value) return 'Not available';
  var d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return 'Not available';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pdfEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildSimplePdfBuffer(title, html) {
  var plain = htmlToPlainText(html);
  var lines = [title || 'Document', '']
    .concat(plain ? plain.split(/\r?\n/) : ['No document content available.'])
    .map(function (line) { return line || ' '; });

  var pageHeight = 842;
  var startY = 790;
  var lineHeight = 16;
  var usableLines = 44;
  var fontObjId = 3;
  var objects = [];
  var pageRefs = [];

  function addObject(id, body) {
    objects.push({ id: id, body: body });
  }

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  var chunks = [];
  for (var i = 0; i < lines.length; i += usableLines) {
    chunks.push(lines.slice(i, i + usableLines));
  }
  if (!chunks.length) chunks.push(['No document content available.']);

  var nextId = 4;
  chunks.forEach(function (chunk) {
    var pageId = nextId++;
    var contentId = nextId++;
    var textOps = ['BT', '/F1 12 Tf'];
    for (var li = 0; li < chunk.length; li++) {
      var y = startY - (li * lineHeight);
      textOps.push('1 0 0 1 50 ' + y + ' Tm (' + pdfEscape(chunk[li]) + ') Tj');
    }
    textOps.push('ET');
    var stream = textOps.join('\n');
    addObject(contentId, '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
    addObject(
      pageId,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ' + pageHeight + '] /Resources << /Font << /F1 ' +
        fontObjId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'
    );
    pageRefs.push(pageId + ' 0 R');
  });

  addObject(2, '<< /Type /Pages /Count ' + pageRefs.length + ' /Kids [' + pageRefs.join(' ') + '] >>');
  objects.sort(function (a, b) { return a.id - b.id; });

  var pdf = '%PDF-1.4\n';
  var offsets = [0];
  objects.forEach(function (obj) {
    offsets[obj.id] = Buffer.byteLength(pdf, 'utf8');
    pdf += obj.id + ' 0 obj\n' + obj.body + '\nendobj\n';
  });

  var xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (var oi = 1; oi <= objects.length; oi++) {
    var off = offsets[oi] || 0;
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';

  return Buffer.from(pdf, 'utf8');
}

function buildContext(resolved) {
  var profile = resolved && resolved.profile ? resolved.profile : {};
  var contact = resolved && resolved.contact ? resolved.contact : {};
  var employment = resolved && resolved.employment ? resolved.employment : {};
  var affordability = resolved && resolved.affordability ? resolved.affordability : {};
  var loan = resolved && resolved.activeLoan ? resolved.activeLoan : {};
  var summary = loan.summary || {};
  var status = loan.status || {};
  var schedule = Array.isArray(loan.schedule) ? loan.schedule : [];
  var totalRepaid = Number(summary.totalRepaid || 0);
  var outstanding = Number(summary.outstandingBalance || 0);
  var principal = Number(loan.core && loan.core.principal || 0);
  var principalPaid = Math.max(0, principal - outstanding);
  var interestPaid = Math.max(0, totalRepaid - principalPaid);
  var loanId = pickValue(profile.loanId, loan.loanId, '');
  return {
    storageKey: resolved && resolved.storageKey || '',
    customerId: resolved && resolved.customerId || '',
    fullName: pickValue(profile.fullName, 'Customer'),
    firstName: pickValue(profile.firstName, 'Customer'),
    lastName: pickValue(profile.lastName, ''),
    address: pickValue(contact.address, 'Not on file'),
    email: pickValue(contact.email, 'Not on file'),
    phone: pickValue(contact.phone, 'Not on file'),
    dob: pickValue(profile.dob, 'Not on file'),
    employer: pickValue(employment.employer, 'Not on file'),
    employmentStatus: pickValue(employment.status, 'Not on file'),
    annualIncome: Number(employment.annualIncome || 0),
    monthlyIncome: Number(affordability.monthlyIncome || 0),
    totalExpenditure: Number(affordability.totalExpenditure || 0),
    disposableIncome: Number(affordability.disposableIncome || 0),
    housingCosts: Number(affordability.housingCosts || 0),
    otherDebts: Number(affordability.otherDebts || 0),
    transportCosts: Number(affordability.transportCosts || 0),
    livingCosts: Number(affordability.livingCosts || 0),
    loanId: loanId,
    loanRef: loanId ? ('#' + loanId) : '-',
    principal: principal,
    apr: Number(loan.core && loan.core.apr || 0),
    termMonths: Number(loan.core && loan.core.termMonths || 0),
    startDate: pickValue(loan.core && loan.core.startDate, loan.originatedAt, ''),
    emi: Number(pickValue(loan.emi, summary.emi, 0)),
    totalRepayable: Number(summary.totalRepayable || 0),
    totalInterest: Number(summary.totalInterest || 0),
    totalRepaid: totalRepaid,
    outstandingBalance: outstanding,
    principalPaid: principalPaid,
    interestPaid: interestPaid,
    instalmentsRemaining: Number(summary.instalmentsRemaining || 0),
    status: pickValue(status.resolvedDisplayStatus, status.baseStatus, 'active'),
    reasonCodes: Array.isArray(status.reasonCodes) ? status.reasonCodes : [],
    schedule: schedule,
    updatedAt: resolved && resolved.updatedAt || '',
    memberSince: pickValue(profile.memberSince, ''),
    now: new Date().toISOString()
  };
}

function makeDoc(type, title, subtitle, html, options) {
  options = options || {};
  var slug = type.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document';
  var loanId = options.loanId || 'account';
  return {
    type: type,
    title: title,
    subtitle: subtitle,
    category: options.category || 'customer',
    available: options.available !== false,
    documentId: options.documentId || ('DOC-' + loanId + '-' + slug.toUpperCase()),
    fileName: options.fileName || (slug + '-' + loanId + '.pdf'),
    html: html
  };
}

function buildDocumentCatalog(resolved, scope) {
  var ctx = buildContext(resolved);
  var issuedDate = fmtDate(ctx.startDate || ctx.updatedAt || ctx.now);
  var generatedDate = fmtDate(ctx.updatedAt || ctx.now);
  var docs = [];

  docs.push(makeDoc(
    'secci',
    'SECCI',
    'Pre-contract information | issued ' + issuedDate,
    '<h3>Standard European Consumer Credit Information</h3>' +
      '<table class="dtbl">' +
      '<tr><td>Borrower</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Loan number</td><td>' + escHtml(ctx.loanRef) + '</td></tr>' +
      '<tr><td>Total amount of credit</td><td>' + escHtml(fmtCurrency(ctx.principal)) + '</td></tr>' +
      '<tr><td>Duration</td><td>' + escHtml(String(ctx.termMonths) + ' months') + '</td></tr>' +
      '<tr><td>Borrowing rate</td><td>' + escHtml(ctx.apr.toFixed(1) + '% per annum (fixed)') + '</td></tr>' +
      '<tr><td>APR</td><td>' + escHtml(ctx.apr.toFixed(1) + '% APR') + '</td></tr>' +
      '<tr><td>Monthly repayment</td><td>' + escHtml(fmtCurrency(ctx.emi)) + '</td></tr>' +
      '<tr><td>Total amount repayable</td><td>' + escHtml(fmtCurrency(ctx.totalRepayable)) + '</td></tr>' +
      '<tr><td>Total cost of credit</td><td>' + escHtml(fmtCurrency(ctx.totalInterest)) + '</td></tr>' +
      '</table>' +
      '<p>You have the right to withdraw from this agreement within 14 days of signing without giving any reason.</p>' +
      '<p style="font-size:10px;color:#64748b">Quido Ltd | FCA Reg. 900001</p>',
    { loanId: ctx.loanId, category: 'customer' }
  ));

  docs.push(makeDoc(
    'adequate',
    'Adequate Explanation',
    'Issued ' + issuedDate,
    '<h3>Adequate Explanation of Credit Agreement</h3>' +
      '<p>Quido provided an explanation of the credit agreement, repayment schedule, total repayable amount, and the consequences of missed payments.</p>' +
      '<table class="dtbl">' +
      '<tr><td>Borrower</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Loan number</td><td>' + escHtml(ctx.loanRef) + '</td></tr>' +
      '<tr><td>Loan amount</td><td>' + escHtml(fmtCurrency(ctx.principal)) + '</td></tr>' +
      '<tr><td>Monthly repayment</td><td>' + escHtml(fmtCurrency(ctx.emi)) + '</td></tr>' +
      '<tr><td>Total repayable</td><td>' + escHtml(fmtCurrency(ctx.totalRepayable)) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'customer' }
  ));

  docs.push(makeDoc(
    'notice',
    'Notice of Cancellation Rights',
    'Issued ' + issuedDate,
    '<h3>Your Right to Cancel</h3>' +
      '<p>You have the right to cancel this credit agreement within 14 days of the day after you receive this notice.</p>' +
      '<p>To cancel, contact Quido in writing using the contact details on file.</p>' +
      '<table class="dtbl">' +
      '<tr><td>Borrower</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Loan number</td><td>' + escHtml(ctx.loanRef) + '</td></tr>' +
      '<tr><td>Issued</td><td>' + escHtml(issuedDate) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'customer' }
  ));

  docs.push(makeDoc(
    'agreement',
    'Credit Agreement',
    'Signed ' + issuedDate,
    '<h3>Consumer Credit Agreement</h3>' +
      '<table class="dtbl">' +
      '<tr><td>Agreement number</td><td>' + escHtml(ctx.loanRef) + '</td></tr>' +
      '<tr><td>Borrower</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Address</td><td>' + escHtml(ctx.address) + '</td></tr>' +
      '<tr><td>Loan amount</td><td>' + escHtml(fmtCurrency(ctx.principal)) + '</td></tr>' +
      '<tr><td>APR</td><td>' + escHtml(ctx.apr.toFixed(1) + '%') + '</td></tr>' +
      '<tr><td>Term</td><td>' + escHtml(String(ctx.termMonths) + ' months') + '</td></tr>' +
      '<tr><td>Monthly payment</td><td>' + escHtml(fmtCurrency(ctx.emi)) + '</td></tr>' +
      '<tr><td>Start date</td><td>' + escHtml(fmtDate(ctx.startDate)) + '</td></tr>' +
      '<tr><td>Total repayable</td><td>' + escHtml(fmtCurrency(ctx.totalRepayable)) + '</td></tr>' +
      '</table>' +
      '<p>Regulated by the Consumer Credit Act 1974. Quido Ltd is authorised and regulated by the FCA.</p>',
    { loanId: ctx.loanId, category: 'customer' }
  ));

  docs.push(makeDoc(
    'annualStatement',
    'Annual Statement',
    'Generated ' + generatedDate,
    '<h3>Annual Statement</h3>' +
      '<table class="dtbl">' +
      '<tr><td>Statement date</td><td>' + escHtml(generatedDate) + '</td></tr>' +
      '<tr><td>Borrower</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Loan number</td><td>' + escHtml(ctx.loanRef) + '</td></tr>' +
      '<tr><td>Loan amount</td><td>' + escHtml(fmtCurrency(ctx.principal)) + '</td></tr>' +
      '<tr><td>Total repaid to date</td><td>' + escHtml(fmtCurrency(ctx.totalRepaid)) + '</td></tr>' +
      '<tr><td>Outstanding balance</td><td>' + escHtml(fmtCurrency(ctx.outstandingBalance)) + '</td></tr>' +
      '<tr><td>Principal paid</td><td>' + escHtml(fmtCurrency(ctx.principalPaid)) + '</td></tr>' +
      '<tr><td>Interest paid</td><td>' + escHtml(fmtCurrency(ctx.interestPaid)) + '</td></tr>' +
      '</table>' +
      '<p>This statement reflects the latest resolved account position at the time of generation.</p>',
    { loanId: ctx.loanId, category: 'customer' }
  ));

  if (scope !== 'ops') return docs;

  var inArrears = /arrears|default|terminated/i.test(ctx.status);

  docs.push(makeDoc(
    'arrears',
    'Notice of Sums in Arrears',
    inArrears ? ('Generated | account in ' + ctx.status) : ('Not generated | account status: ' + ctx.status),
    '<h3>Notice of Sums in Arrears</h3>' +
      '<p>' + escHtml(inArrears
        ? ('Account is currently in ' + ctx.status + '. This notice summarises the arrears position.')
        : 'This notice is not currently generated because the account is not in arrears.') + '</p>' +
      '<table class="dtbl">' +
      '<tr><td>Outstanding balance</td><td>' + escHtml(fmtCurrency(ctx.outstandingBalance)) + '</td></tr>' +
      '<tr><td>Status</td><td>' + escHtml(ctx.status) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'customer', available: inArrears }
  ));

  docs.push(makeDoc(
    'creditRisk',
    'Credit Risk Assessment',
    'Completed at origination ' + issuedDate,
    '<h3>Credit Risk Assessment</h3>' +
      '<p>Internal underwriting summary retained for audit and quality review.</p>' +
      '<table class="dtbl">' +
      '<tr><td>Customer</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Loan number</td><td>' + escHtml(ctx.loanRef) + '</td></tr>' +
      '<tr><td>Completed</td><td>' + escHtml(issuedDate) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'internal' }
  ));

  docs.push(makeDoc(
    'affordabilityAssessment',
    'Affordability Assessment',
    'Latest resolved affordability snapshot',
    '<h3>Affordability Assessment</h3>' +
      '<table class="dtbl">' +
      '<tr><td>Customer</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Monthly income</td><td>' + escHtml(fmtCurrency(ctx.monthlyIncome)) + '</td></tr>' +
      '<tr><td>Total expenditure</td><td>' + escHtml(fmtCurrency(ctx.totalExpenditure)) + '</td></tr>' +
      '<tr><td>Disposable income</td><td>' + escHtml(fmtCurrency(ctx.disposableIncome)) + '</td></tr>' +
      '<tr><td>Monthly repayment</td><td>' + escHtml(fmtCurrency(ctx.emi)) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'internal' }
  ));

  docs.push(makeDoc(
    'incomeExpenditure',
    'Income and Expenditure Record',
    'Updated ' + generatedDate,
    '<h3>Income and Expenditure Record</h3>' +
      '<table class="dtbl">' +
      '<tr><td>Monthly income</td><td>' + escHtml(fmtCurrency(ctx.monthlyIncome)) + '</td></tr>' +
      '<tr><td>Housing costs</td><td>' + escHtml(fmtCurrency(ctx.housingCosts)) + '</td></tr>' +
      '<tr><td>Transport costs</td><td>' + escHtml(fmtCurrency(ctx.transportCosts)) + '</td></tr>' +
      '<tr><td>Living costs</td><td>' + escHtml(fmtCurrency(ctx.livingCosts)) + '</td></tr>' +
      '<tr><td>Other debts</td><td>' + escHtml(fmtCurrency(ctx.otherDebts)) + '</td></tr>' +
      '<tr><td>Total expenditure</td><td>' + escHtml(fmtCurrency(ctx.totalExpenditure)) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'internal' }
  ));

  docs.push(makeDoc(
    'kyc',
    'KYC and Identity Verification',
    'Resolved profile snapshot',
    '<h3>KYC and Identity Verification</h3>' +
      '<table class="dtbl">' +
      '<tr><td>Customer</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Date of birth</td><td>' + escHtml(ctx.dob) + '</td></tr>' +
      '<tr><td>Address</td><td>' + escHtml(ctx.address) + '</td></tr>' +
      '<tr><td>Email</td><td>' + escHtml(ctx.email) + '</td></tr>' +
      '<tr><td>Phone</td><td>' + escHtml(ctx.phone) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'internal' }
  ));

  docs.push(makeDoc(
    'consent',
    'Data Processing Consent Record',
    'Profile and account consent snapshot',
    '<h3>Data Processing Consent Record</h3>' +
      '<p>Customer consent and servicing permissions are retained against the latest resolved account record.</p>' +
      '<table class="dtbl">' +
      '<tr><td>Customer</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Customer ID</td><td>' + escHtml(ctx.customerId) + '</td></tr>' +
      '<tr><td>Account key</td><td>' + escHtml(ctx.storageKey) + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'internal' }
  ));

  docs.push(makeDoc(
    'vulnerability',
    'Vulnerability Assessment',
    'Latest servicing review snapshot',
    '<h3>Vulnerability Assessment</h3>' +
      '<p>Operational review summary held for servicing support and treatment monitoring.</p>' +
      '<table class="dtbl">' +
      '<tr><td>Customer</td><td>' + escHtml(ctx.fullName) + '</td></tr>' +
      '<tr><td>Account status</td><td>' + escHtml(ctx.status) + '</td></tr>' +
      '<tr><td>Reason codes</td><td>' + escHtml(ctx.reasonCodes.join(', ') || 'None') + '</td></tr>' +
      '</table>',
    { loanId: ctx.loanId, category: 'internal' }
  ));

  return docs;
}

function getDocument(catalog, type) {
  for (var i = 0; i < catalog.length; i++) {
    if (catalog[i].type === type) return catalog[i];
  }
  return null;
}

module.exports = {
  buildDocumentCatalog: buildDocumentCatalog,
  getDocument: getDocument,
  buildSimplePdfBuffer: buildSimplePdfBuffer
};
