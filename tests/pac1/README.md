# PAC 1.0 Partner Automation

End-to-end automation suite for **PAC 1.0** partner redemption flows.

### Architecture & Key Components
- **Test Suite**: [`tests/pac1/pac1.spec.ts`](./pac1.spec.ts)
- **Page Object**: [`pages/Pac1Page.ts`](../../pages/Pac1Page.ts)
- **Partner Access Code API Client**: [`utils/pac1ApiClient.ts`](../../utils/pac1ApiClient.ts)
- **Network Interceptors & WAF Token Bridge**: [`utils/pac1NetworkHelper.ts`](../../utils/pac1NetworkHelper.ts)
- **Configuration**: [`config/pac1/telefonica_es.json`](../../config/pac1/telefonica_es.json)
- **CI/CD Workflow**: [`.github/workflows/web--pac1-automation.yml`](../../.github/workflows/web--pac1-automation.yml)

### Supported Scenarios
1. **New User Partner Signup**: Partner landing -> Welcome Modal -> Email & Password Registration -> Confirmation Summary -> Start Subscription -> My Account Verification.
2. **Pre-Authenticated Existing User (`pre_auth`)**: Signed-in user pastes redemption URL -> Land on `SignUpConfirmationPageUnified` -> Confirm & Activate -> My Account Verification.
3. **Logged-Out Existing User (`logged_out`)**: Paste redemption URL -> Welcome Modal -> Click "SIGN IN" -> Authenticate -> Offer Auto-Activation -> My Account Verification.
4. **User Types**: New, Freemium, Active Paid (double-billing copy checks), Frozen (6 Staging QA accounts), and Partial accounts.

### Reports
Generates standard HTML, PDF, and full-session Playwright WebM recordings in `reports/`.
