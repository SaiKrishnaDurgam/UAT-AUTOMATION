# PPV (Pay-Per-View) Automation Suites

This directory represents the PPV testing domain:
- **New User Signup Flows**: [`tests/new_user/newuser.ppv.spec.ts`](../new_user/newuser.ppv.spec.ts)
- **Existing User Redemption / Purchase**: [`tests/existing_user/existinguser.ppv.spec.ts`](../existing_user/existinguser.ppv.spec.ts)
- **Visual Regression Validation**: [`tests/visual/`](../visual/)
- **Checkout Figma Validation**: [`tests/generated/ppv-checkout-figma.spec.ts`](../generated/ppv-checkout-figma.spec.ts)

Configs:
- Primary PPV Config: [`config/ppv/PPV.json`](../../config/ppv/PPV.json)
- Event Definitions: [`config/events/`](../../config/events/)
- Plan Offer Types & Cancellation: [`config/DaznPlan.json`](../../config/DaznPlan.json)

Data:
- Primary PPV Input Data: [`data/ppv/PPV_Input.xlsx`](../../data/ppv/PPV_Input.xlsx)
