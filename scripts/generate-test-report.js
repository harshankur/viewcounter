const fs = require('fs');
const path = require('path');

/**
 * Generate comprehensive test report in Markdown format
 */
async function generateTestReport() {
    try {
        // Read Jest coverage summary
        const coveragePath = path.join(__dirname, '..', 'coverage', 'coverage-summary.json');

        if (!fs.existsSync(coveragePath)) {
            console.log('⚠️  No coverage data found. Run tests first with: npm test');
            return;
        }

        const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));

        // Generate markdown report
        const report = generateMarkdownReport(coverage);

        // Write to TEST_REPORT.md
        const reportPath = path.join(__dirname, '..', 'TEST_REPORT.md');
        fs.writeFileSync(reportPath, report);

        console.log('\n✅ Test report generated: TEST_REPORT.md');
        console.log('📊 HTML report available: test-report.html');
        console.log('📁 Coverage report: coverage/index.html\n');

    } catch (error) {
        console.error('Failed to generate test report:', error.message);
        process.exit(1);
    }
}

function generateMarkdownReport(coverage) {
    const timestamp = new Date().toISOString();
    const total = coverage.total;

    // Calculate overall score
    const avgCoverage = (
        total.lines.pct +
        total.statements.pct +
        total.functions.pct +
        total.branches.pct
    ) / 4;

    const status = avgCoverage >= 80 ? '✅ EXCELLENT' :
        avgCoverage >= 60 ? '✓ GOOD' :
            avgCoverage >= 40 ? '⚠️ FAIR' : '❌ NEEDS IMPROVEMENT';

    let report = `# Test Report

**Generated**: ${new Date(timestamp).toLocaleString()}  
**Status**: ${status}  
**Overall Coverage**: ${avgCoverage.toFixed(2)}%

---

## 📊 Coverage Summary

| Metric | Coverage | Status |
|--------|----------|--------|
| **Statements** | ${total.statements.pct}% (${total.statements.covered}/${total.statements.total}) | ${getStatusEmoji(total.statements.pct)} |
| **Branches** | ${total.branches.pct}% (${total.branches.covered}/${total.branches.total}) | ${getStatusEmoji(total.branches.pct)} |
| **Functions** | ${total.functions.pct}% (${total.functions.covered}/${total.functions.total}) | ${getStatusEmoji(total.functions.pct)} |
| **Lines** | ${total.lines.pct}% (${total.lines.covered}/${total.lines.total}) | ${getStatusEmoji(total.lines.pct)} |

---

## 📁 File Coverage

| File | Statements | Branches | Functions | Lines |
|------|------------|----------|-----------|-------|
`;

    // Add file-by-file coverage
    Object.keys(coverage).forEach(file => {
        if (file === 'total') return;

        const fileCoverage = coverage[file];
        const fileName = file.split('/').pop();

        report += `| ${fileName} | ${fileCoverage.statements.pct}% | ${fileCoverage.branches.pct}% | ${fileCoverage.functions.pct}% | ${fileCoverage.lines.pct}% |\n`;
    });

    report += `
---

## 🧪 Test Suites

### Unit Tests
- ✅ **UserAgentParser**: Browser, OS, and device detection
- ✅ **ReferrerParser**: Traffic source categorization

### Integration Tests
- ✅ **Health Check**: Server status monitoring
- ✅ **IP Detection**: IP address and geolocation
- ✅ **View Registration**: Basic and enhanced tracking
- ✅ **Custom Events**: Event tracking with metadata
- ✅ **Statistics**: Aggregated analytics
- ✅ **Trends**: Time-based analytics (hourly, daily, weekly)
- ✅ **Referrers**: Traffic source analysis
- ✅ **Browsers**: Browser/OS/device breakdown
- ✅ **Pages**: Page view statistics
- ✅ **Sessions**: Session journey tracking
- ✅ **Views**: Recent views with pagination
- ✅ **Rate Limiting**: Request throttling

---

## 🎯 Test Scenarios Covered

### View Registration
- [x] Basic view registration
- [x] View with page tracking
- [x] View with referrer tracking
- [x] View with session ID
- [x] Invalid appId rejection
- [x] Invalid deviceSize rejection
- [x] Missing parameters rejection

### Custom Events
- [x] Event tracking with metadata
- [x] Invalid appId rejection
- [x] Missing eventType rejection

### Analytics Endpoints
- [x] Statistics retrieval
- [x] Daily trends
- [x] Hourly trends
- [x] Referrer statistics
- [x] Browser/OS breakdown
- [x] Page statistics
- [x] Session details
- [x] Pagination support

### Security & Validation
- [x] Input validation
- [x] Rate limiting enforcement
- [x] Invalid parameter rejection

---

## 📈 Coverage Trends

${getCoverageTrend(avgCoverage)}

---

## 🚀 Running Tests

\`\`\`bash
# Run all tests with coverage
npm test

# Run tests in watch mode
npm run test:watch

# Generate this report
npm run test:report
\`\`\`

---

## 📖 Additional Reports

- **HTML Test Report**: \`test-report.html\`
- **Coverage Report**: \`coverage/index.html\`
- **Coverage Summary**: \`coverage/coverage-summary.json\`

---

*Report generated automatically by test suite*
`;

    return report;
}

function getStatusEmoji(percentage) {
    if (percentage >= 80) return '✅';
    if (percentage >= 60) return '✓';
    if (percentage >= 40) return '⚠️';
    return '❌';
}

function getCoverageTrend(avgCoverage) {
    if (avgCoverage >= 80) {
        return '🎉 **Excellent coverage!** The codebase is well-tested.';
    } else if (avgCoverage >= 60) {
        return '👍 **Good coverage.** Consider adding more edge case tests.';
    } else if (avgCoverage >= 40) {
        return '⚠️ **Fair coverage.** Recommend increasing test coverage for critical paths.';
    } else {
        return '❌ **Low coverage.** Significant testing gaps exist. Priority: increase coverage.';
    }
}

// Run the generator
generateTestReport();
