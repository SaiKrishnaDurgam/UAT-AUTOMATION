/**
 * PAC 1.0 Partner Access Code API Client
 * Generates dynamic access codes via the internal Partners API for PAC 1.0 campaigns (e.g. Telefonica / Movistar)
 */

export interface Pac1AccessCodeResponse {
  accessCode: string;
}

export class Pac1ApiClient {
  private static readonly STAGING_ENDPOINT = 'https://partners.ar.dazn-stage.com/v1/internal/api/access-codes';
  private static readonly PROD_ENDPOINT = 'https://partners.ar.dazn.com/v1/internal/api/access-codes';

  // Default Staging authentication headers identified from Postman workspace
  private static readonly DEFAULT_AUTH_KEY = 'ZEOJZ9jbH0wcL7bmksmxLepI5IquOm8jzeuLO4kr80VdXsbfKO3F6D5Rltwm';
  private static readonly DEFAULT_TEAM = 'Payspec';

  /**
   * Dynamically generate a PAC 1.0 access code for a given campaign name.
   * @param campaignName e.g. "DAZN x BA-BD"
   * @param env "staging" | "prod" (defaults to staging)
   */
  static async generateAccessCode(campaignName: string, env: string = 'staging'): Promise<string> {
    const endpoint = env === 'prod' ? this.PROD_ENDPOINT : this.STAGING_ENDPOINT;
    const authKey = process.env.PAC1_AUTH_KEY || this.DEFAULT_AUTH_KEY;
    const team = process.env.PAC1_TEAM || this.DEFAULT_TEAM;

    console.log(`📡 [PAC 1.0 API] Requesting new access code for campaign: "${campaignName}" on ${env}...`);
    console.log(`   Endpoint: ${endpoint}`);

    const payload = { campaignName };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dazn-Auth-Key': authKey,
          'x-dazn-team': team,
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }

      if (!response.ok) {
        throw new Error(
          `❌ [PAC 1.0 API] Failed to generate access code (HTTP ${response.status} ${response.statusText}):\n` +
          `   Response: ${typeof data === 'object' ? JSON.stringify(data) : data}`
        );
      }

      if (!data || !data.accessCode) {
        throw new Error(`❌ [PAC 1.0 API] Invalid response payload, missing "accessCode": ${JSON.stringify(data)}`);
      }

      console.log(`✅ [PAC 1.0 API] Successfully generated access code: ${data.accessCode}`);
      return data.accessCode;
    } catch (err: any) {
      console.error(`💥 [PAC 1.0 API] Error during access code generation: ${err.message}`);
      throw err;
    }
  }

  /**
   * Construct the PAC 1.0 campaign redemption URL.
   * e.g. https://stag.dazn.com/en-ES/redeem/campaign/telefonica/giftcode/TFBABDzw5KV32bs5i
   */
  static buildRedemptionUrl(baseUrl: string, locale: string, partner: string, accessCode: string): string {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const cleanLocale = locale.replace(/^\/+|\/+$/g, '');
    const cleanPartner = partner.replace(/^\/+|\/+$/g, '');
    const cleanCode = accessCode.trim();

    return `${cleanBase}/${cleanLocale}/redeem/campaign/${cleanPartner}/giftcode/${cleanCode}`;
  }
}
