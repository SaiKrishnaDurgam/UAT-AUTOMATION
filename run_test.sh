#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# DAZN PPV New User Flow — test runner
#
# Key environment variables:
#   DAZN_REGION   : GB | AU | US | AE (default: GB)
#   DAZN_ENV      : prod | stag       (default: prod)
#   PLAN          : standard_monthly | standard_annual_pay_monthly |
#                   standard_annual_pay_upfront | ultimate_monthly  (default: standard_monthly)
#   SOURCE        : landing-page-banner | home-page-get-started | home-page-live-tv-rail |
#                   home-page-banner | home-page-dont-miss | home-boxing-banner |
#                   home-boxing-tile | boxing-page-banner | boxing-page-bundle |
#                   search | schedule                              (default: landing-page-banner)
#   PPV_EVENT     : event key from config/ppv.json
#                   e.g. beauty_and_beast | ppv_t_joshua_prenga | standalone_collision
#   PPV_CONFIG    : legacy — JSON filename or event key (overrides PPV_EVENT)
# ─────────────────────────────────────────────────────────────────────────────
cd /Users/Hari.Prasad/jobbot/dazn-tests
export DAZN_ENV=prod
export DAZN_REGION=US
export PLAN=standard_monthly
export SOURCE=landing-page-banner
export PPV_EVENT=zayas_boots
npx playwright test tests/new_user/newuser.ppv.spec.ts --headed 2>&1 | tee test_output.log
