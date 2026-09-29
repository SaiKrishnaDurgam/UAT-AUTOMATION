# PAC 2.0 Partner Automation

End-to-end automation suite for **PAC 2.0** partner redemption flows.

### Architecture & Key Components
- **Test Suite**: [`tests/pac2/pac2.spec.ts`](./pac2.spec.ts)
- **Page Object**: [`pages/PacPage.ts`](../../pages/PacPage.ts)
- **URL Pool Manager**: [`utils/pacUrlPool.ts`](../../utils/pacUrlPool.ts)
- **Configuration**: [`config/pac2/`](../../config/pac2/) (`simplysubscribe_br.json`, `viking_be.json`)
- **Data (Link Pools)**: [`data/pac2/`](../../data/pac2/)
- **CI/CD Workflow**: [`.github/workflows/web--pac2-automation.yml`](../../.github/workflows/web--pac2-automation.yml)

### Supported Partners
- **SimplySubscribe Brazil**: `standard_flex`, `ultimate_annual`
- **Mobile Vikings Belgium**: `standard_flex`

### Reports
Generates standard HTML, PDF, and full-session Playwright WebM recordings in `reports/`.
