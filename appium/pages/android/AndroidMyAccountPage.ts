import { AndroidBasePage, AndroidFlowHooks, WdBrowser, WdElement, adbTap, getScreenSize } from './AndroidBasePage';

export interface AndroidLoginCredentials {
  email?: string;
  password?: string;
  navigateToHomeAfterLogin?: boolean;
}

export class AndroidMyAccountPage extends AndroidBasePage {
  async preLoginFlow(baseUrl: string, credentials: AndroidLoginCredentials = {}): Promise<void> {
    void baseUrl;
    console.log('\nPRE-LOGIN FLOW: Signing in existing user...');
    await this.driver.pause(500);

    // Fresh installs now open directly on the combined Log in / sign up
    // screen.  There is no profile/menu action to take in that case.
    const emailScreen = await this.findEl(
      'android=new UiSelector().className("android.widget.EditText")',
      10000,
    );
    
    // Declare emailInput at function level so it can be used in password section
    let emailInput: any = null;
    let emailNeededFallback = false;

    const directLoginSelectors = [
      // Exact text matches (Android UiSelector is case-sensitive)
      'android=new UiSelector().text("Sign In")',
      'android=new UiSelector().text("Sign in")',
      'android=new UiSelector().text("Log In")',
      'android=new UiSelector().text("Log in")',
      'android=new UiSelector().text("Login")',
      // Exact description matches
      'android=new UiSelector().description("Sign In")',
      'android=new UiSelector().description("Sign in")',
      'android=new UiSelector().description("Log In")',
      'android=new UiSelector().description("Log in")',
      'android=new UiSelector().description("Login")',
      // Contains text matches
      'android=new UiSelector().textContains("Sign In")',
      'android=new UiSelector().textContains("Sign in")',
      'android=new UiSelector().textContains("Log In")',
      'android=new UiSelector().textContains("Log in")',
      'android=new UiSelector().textContains("Login")',
      'android=new UiSelector().descriptionContains("Sign In")',
      'android=new UiSelector().descriptionContains("Sign in")',
      'android=new UiSelector().descriptionContains("Log In")',
      'android=new UiSelector().descriptionContains("Log in")',
      'android=new UiSelector().descriptionContains("Login")',
      // XPath fallback: case-insensitive text match
      '//*[contains(translate(text(), "LOGIN", "login"), "login") or contains(translate(text(), "SIGN IN", "sign in"), "sign in")]',
    ];

    let loginClicked = !!emailScreen;
    for (const selector of emailScreen ? [] : directLoginSelectors) {
      try {
        const loginBtn = await this.driver.$(selector);
        if (await loginBtn.isDisplayed()) {
          console.log(`  Found direct login button with selector: ${selector}, clicking...`);
          await loginBtn.click();
          await this.driver.pause(1500);
          loginClicked = true;
          break;
        }
      } catch {}
    }

    if (!loginClicked) {
      console.log('  Direct login button not found, trying via Profile/Account icon...');
      const profileSelectors = [
        'android=new UiSelector().descriptionContains("Profile")',
        'android=new UiSelector().descriptionContains("Account")',
        'android=new UiSelector().textContains("Profile")',
        'android=new UiSelector().textContains("Account")',
        '//android.widget.ImageView[contains(@content-desc, "Profile")]',
        '//android.widget.ImageView[contains(@content-desc, "Account")]',
      ];

      let profileFound = false;
      for (const selector of profileSelectors) {
        try {
          const profileBtn = await this.driver.$(selector);
          if (await profileBtn.isDisplayed()) {
            console.log('  Found Profile/Account button, tapping...');
            await profileBtn.click();
            await this.driver.pause(800);
            profileFound = true;
            break;
          }
        } catch {}
      }

      if (!profileFound) {
        console.log('  Profile button not found via selectors, trying coordinate tap...');
        const screenSize = getScreenSize();
        adbTap(Math.round(screenSize.width * 0.90), Math.round(screenSize.height * 0.06));
        await this.driver.pause(1000);
      }

      for (const selector of directLoginSelectors) {
        try {
          const signInBtn = await this.driver.$(selector);
          if (await signInBtn.isDisplayed()) {
            console.log('  Found Sign In button in profile menu, tapping...');
            await signInBtn.click();
            await this.driver.pause(1500);
            loginClicked = true;
            break;
          }
        } catch {}
      }
    }

    if (credentials.email) {
      console.log(`  Entering email: ${credentials.email}`);
      const emailSelectors = [
        'android=new UiSelector().className("android.widget.EditText")',
        '//*[@resource-id="EmailAddressField"]',
        'android=new UiSelector().resourceIdMatches(".*(email|username).*")',
        'android=new UiSelector().descriptionContains("Email")',
        'android=new UiSelector().textContains("Email")',
        '//android.widget.EditText',
      ];
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const selector of emailSelectors) {
          emailInput = await this.findEl(selector, 2000);
          if (emailInput) break;
        }
        if (emailInput) break;
        await this.driver.pause(1000);
      }
      if (!emailInput) {
        throw new Error('Login screen opened but no email input was found');
      }

      // Wait for element to be interactable and click it to ensure focus
      await emailInput.waitForDisplayed({ timeout: 5000 });
      await emailInput.click();
      await this.driver.pause(500);
      
      // Clear any existing text and wait for the field to be ready
      await emailInput.clearValue();
      await this.driver.pause(300);
      
      // Set the email value
      await emailInput.setValue(credentials.email);
      const readEmail = async (): Promise<string> => (
        await emailInput.getAttribute('text').catch(() => '') ||
        await emailInput.getText().catch(() => '')
      );
      let enteredEmail = await readEmail();
      if (enteredEmail.toLowerCase() !== credentials.email.toLowerCase()) {
        emailNeededFallback = true;
        // Compose text fields on some Android builds ignore setValue but accept
        // key events. Clear first so this remains safe on a partially-filled UI.
        await emailInput.clearValue();
        await emailInput.click().catch(() => {});
        await this.driver.keys([...credentials.email]);
        enteredEmail = await readEmail();
      }
      if (enteredEmail.toLowerCase() !== credentials.email.toLowerCase()) {
        throw new Error('Email input did not retain the requested credential');
      }
      await this.driver.pause(500);

        const continueSelectors = [
          '//*[@resource-id="GetStartedButton"]',
          'android=new UiSelector().text("Get started")',
          'android=new UiSelector().text("Get Started")',
          'android=new UiSelector().text("Continue")',
          'android=new UiSelector().text("Next")',
          'android=new UiSelector().textContains("Get started")',
          'android=new UiSelector().textContains("Get Started")',
          'android=new UiSelector().textContains("Next")',
        ];

      for (const selector of continueSelectors) {
        try {
          const continueBtn = await this.driver.$(selector);
          if (await continueBtn.isDisplayed()) {
            await continueBtn.click();
            await this.driver.pause(1500);
            break;
          }
        } catch {}
        }
    }

    if (credentials.password) {
      console.log('  Entering password...');
      
      // The sign-in form is rendered asynchronously after the email step. Do
      // not reuse the email element: its reference remains valid even after
      // the password page replaces it, which causes input to be sent nowhere.
      const passwordSelectors = [
        'android=new UiSelector().className("android.widget.EditText").password(true)',
        '//android.widget.EditText[contains(translate(@resource-id, "PASSWORD", "password"), "password")]',
        'android=new UiSelector().className("android.widget.EditText").resourceIdMatches(".*[Pp]assword.*")',
        '//android.widget.EditText[@resource-id="PasswordField"]',
      ];
      let passwordInput: WdElement = null;
      
      for (const selector of passwordSelectors) {
        passwordInput = await this.findEl(selector, 10000);
        if (passwordInput) {
          console.log(`  Found password field by selector: ${selector}`);
          break;
        }
      }
      
      // Some Compose builds omit the Android password flag. In that case the
      // sole visible EditText on the password screen is the safe fallback.
      // Some Compose builds omit the Android password flag. In that case, find all EditText elements
      // and pick the one that is likely the password input (e.g. not displaying the email address).
      if (!passwordInput) {
        const fields = await this.driver.$$('android=new UiSelector().className("android.widget.EditText")');
        console.log(`  Found ${fields.length} EditText fields on password page`);
        for (const field of fields) {
          try {
            if (await field.isDisplayed()) {
              const textVal = (await field.getAttribute('text').catch(() => '') || '').toLowerCase();
              const emailVal = (credentials.email || '').toLowerCase();
              if (!textVal.includes('@') && (emailVal === '' || !textVal.includes(emailVal))) {
                console.log(`  Selecting EditText field as password input (text: "${textVal}")`);
                passwordInput = field;
                break;
              }
            }
          } catch {}
        }
      }
      
      if (!passwordInput) {
        throw new Error('Email was submitted but no password input was found');
      }

      // Wait for element to be interactable (do not click yet to avoid triggering autofill prompts)
      await passwordInput.waitForDisplayed({ timeout: 5000 });

      const readPassword = async (): Promise<string> => (
        await passwordInput.getAttribute('text').catch(() => '') ||
        await passwordInput.getText().catch(() => '')
      );
      const hasBullets = (val: string) => val.includes('•') || val.includes('●') || val.includes('*');
      const isPlaceholderOrEmpty = (val: string) => {
        const cleaned = val.trim().toLowerCase();
        return cleaned === '' || cleaned === 'password' || cleaned === 'enter password' || cleaned === 'enter your password';
      };

      const focusPasswordInput = async () => {
        try {
          const rect = await passwordInput.getRect();
          // Tap on the left side of the input field to prevent hitting the password visibility toggle icon on the right
          const tapX = Math.round(rect.x + 50);
          const tapY = Math.round(rect.y + rect.height / 2);
          console.log(`  Tapping password field at coordinate (${tapX}, ${tapY}) to focus...`);
          await this.driver.performActions([{
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: tapX, y: tapY },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 }
            ]
          }]);
          await this.driver.pause(500);
        } catch (err: any) {
          console.warn(`  Coordinate focus tap failed: ${err.message}. Falling back to native click...`);
          await passwordInput.click().catch(() => {});
        }
      };

      const tryAdbFallback = async () => {
        console.log('  Password input still empty. Trying ADB shell input text fallback...');
        const escaped = credentials.password.replace(/([$"`\\!*?&|()<>#~;])/g, '\\$1');
        try {
          const { execSync } = require('child_process');
          const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
          const ADB = `${ANDROID_SDK}/platform-tools/adb`;

          // Get the UDID capability from the Appium driver to support multi-device/multi-runner environments
          const caps: any = (this.driver as any).capabilities || {};
          const udid = caps['appium:udid'] || caps.udid || caps['appium:deviceUDID'] || caps.deviceUDID || process.env.DEVICE_SERIAL || '';
          const serialArg = udid ? `-s ${udid}` : '';

          console.log(`  Executing ADB command on device serial: "${udid || 'default'}"`);
          execSync(`${ADB} ${serialArg} shell input text "${escaped}"`);
          await this.driver.pause(1000);
          console.log('  ADB shell input text fallback executed');
        } catch (adbErr: any) {
          console.warn(`  ADB text input failed: ${adbErr.message}`);
        }
      };

      if (emailNeededFallback) {
        console.log('  Email input required key events fallback. Using driver.keys directly for password...');
        await focusPasswordInput();
        await this.driver.keys([...credentials.password]);

        const enteredPassword = await readPassword();
        if (isPlaceholderOrEmpty(enteredPassword) && !hasBullets(enteredPassword)) {
          await tryAdbFallback();
        }
      } else {
        let setValueSuccess = false;
        try {
          await passwordInput.setValue(credentials.password);
          setValueSuccess = true;
          console.log('  ✓ Password entered via setValue');
        } catch (err: any) {
          console.warn(`  setValue failed with error: ${err.message}. Falling back to driver.keys...`);
        }

        if (!setValueSuccess) {
          console.log('  Falling back to driver.keys for password entry...');
          await focusPasswordInput();
          await this.driver.keys([...credentials.password]);

          const enteredPassword = await readPassword();
          if (isPlaceholderOrEmpty(enteredPassword) && !hasBullets(enteredPassword)) {
            await tryAdbFallback();
          }
        }
      }
      await this.driver.pause(500);

      if (await this.driver.isKeyboardShown().catch(() => false)) {
        console.log('  Keyboard is visible — hiding keyboard to expose Sign In buttons...');
        await this.driver.hideKeyboard().catch(() => {});
        await this.driver.pause(1000);
      }
 
      const signInSelectors = [
          'android=new UiSelector().text("Sign In")',
          'android=new UiSelector().text("Sign in")',
          'android=new UiSelector().text("Log In")',
          'android=new UiSelector().text("Log in")',
          'android=new UiSelector().textContains("Sign In")',
          'android=new UiSelector().textContains("Sign in")',
          'android=new UiSelector().textContains("Log In")',
          'android=new UiSelector().textContains("Log in")',
        ];

      for (const selector of signInSelectors) {
        try {
          const signInBtnFinal = await this.driver.$(selector);
          if (await signInBtnFinal.isDisplayed()) {
            await signInBtnFinal.click();
            await this.driver.pause(2500);
            break;
          }
        } catch {}
      }
    }

    await this.driver.pause(2000);

    // 1. Check & click Notification Accept / Permission Allow popup after navigation from login screen
    await this.handleNotificationPermissionPopup(8000);
    await this.handleUpdatePaymentMethodPopup(4000);

    // 2. Only navigate to Home if requested (skip for myaccount flow which navigates directly to My Account)
    if (credentials.navigateToHomeAfterLogin !== false) {
      console.log('⏳ Finding Home tab and navigating to Home page after login...');
      const homeSelectorsAfterLogin = [
        'android=new UiSelector().text("Home")',
        'android=new UiSelector().descriptionContains("Home")',
        '//android.widget.ImageView[contains(@content-desc, "Home")]',
        '//android.widget.TextView[contains(@text, "Home")]',
      ];

      let homeFound = false;
      const startTime = Date.now();
      const maxWaitMs = 15000;

      while (Date.now() - startTime < maxWaitMs) {
        // Re-check notification popup & payment popup if they appear late during page render
        await this.handleNotificationPermissionPopup(1500);
        await this.handleUpdatePaymentMethodPopup(1500);

        for (const selector of homeSelectorsAfterLogin) {
          try {
            const homeEl = await this.driver.$(selector);
            if (await homeEl.isDisplayed().catch(() => false)) {
              console.log('  ✓ Home tab found on screen. Tapping Home tab...');
              await homeEl.click();
              await this.driver.pause(2500);
              homeFound = true;
              break;
            }
          } catch {}
        }
        if (homeFound) break;
        console.log('  Waiting for Home screen tab to appear...');
        await this.driver.pause(1500);
      }

      if (!homeFound) {
        console.log('  Checking if already on Home screen...');
        await this.tapByText('Home', 2000).catch(() => false);
      }
      
      console.log('Post-login navigation to Home completed\n');
    } else {
      console.log('Skipping Home navigation (myaccount flow)\n');
    }
  }

  async handleNotificationPermissionPopup(timeoutMs = 8000): Promise<boolean> {
    console.log('🔔 Checking for post-login Notification / Permission Accept popup...');
    const acceptSelectors = [
      'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_button")',
      'android=new UiSelector().text("Allow")',
      'android=new UiSelector().text("ALLOW")',
      'android=new UiSelector().text("Accept")',
      'android=new UiSelector().text("ACCEPT")',
      'android=new UiSelector().text("Turn on")',
      'android=new UiSelector().text("Enable")',
      'android=new UiSelector().text("OK")',
      'android=new UiSelector().textContains("Allow")',
      'android=new UiSelector().textContains("Turn on")',
      'android=new UiSelector().textContains("Accept")',
      '//android.widget.Button[contains(@text, "Allow") or contains(@text, "Accept") or contains(@text, "Turn on") or contains(@text, "OK")]',
    ];

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      for (const selector of acceptSelectors) {
        try {
          const btn = await this.driver.$(selector);
          if (await btn.isDisplayed().catch(() => false)) {
            console.log(`  ✓ Notification / Permission Accept popup detected. Tapping Accept / Allow...`);
            await btn.click();
            await this.driver.pause(2000);
            return true;
          }
        } catch {}
      }
      await this.driver.pause(1000);
    }
    console.log('  ℹ️ No notification popup detected within timeout.');
    return false;
  }

  async handleUpdatePaymentMethodPopup(timeoutMs = 6000): Promise<boolean> {
    console.log('💳 Checking for "Update Your Payment Method" popup...');
    const popupHeaderSelectors = [
      'android=new UiSelector().textMatches("(?i).*update (your )?payment method.*")',
      'android=new UiSelector().textContains("UPDATE YOUR PAYMENT METHOD")',
      'android=new UiSelector().textContains("Update your payment method")',
      '//android.widget.TextView[contains(translate(@text, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "update your payment method")]',
      'android=new UiSelector().textMatches("(?i).*your latest payment for dazn.*")',
    ];

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      let headerEl: any = null;
      for (const sel of popupHeaderSelectors) {
        try {
          const el = await this.driver.$(sel);
          if (await el.isDisplayed().catch(() => false)) {
            headerEl = el;
            break;
          }
        } catch {}
      }

      if (headerEl) {
        console.log('  💳 "Update Your Payment Method" popup detected. Dismissing via X close icon...');

        // 1. Try finding X close button selector
        const closeSelectors = [
          '//android.widget.ImageView[contains(@content-desc, "Close") or contains(@content-desc, "close") or contains(@resource-id, "close") or contains(@resource-id, "dismiss")]',
          '//android.widget.ImageButton[contains(@content-desc, "Close") or contains(@content-desc, "close") or contains(@resource-id, "close") or contains(@resource-id, "dismiss")]',
          'android=new UiSelector().descriptionMatches("(?i).*(close|dismiss).*")',
          'android=new UiSelector().resourceIdMatches("(?i).*(close|dismiss).*")',
          '//*[@content-desc="Close" or @content-desc="close" or @content-desc="Dismiss" or @content-desc="dismiss"]',
        ];

        for (const sel of closeSelectors) {
          try {
            const btn = await this.driver.$(sel);
            if (await btn.isDisplayed().catch(() => false)) {
              await btn.click();
              console.log(`  ✓ Clicked X close icon via selector: ${sel}`);
              await this.driver.pause(2000);
              return true;
            }
          } catch {}
        }

        // 2. Coordinate fallback: tap top-right 'X' area of the popup modal
        try {
          const { width, height } = await this.driver.getWindowRect();
          const loc = await headerEl.getLocation().catch(() => null);
          const tapY = loc && loc.y > 150 ? Math.max(loc.y - 70, Math.round(loc.y * 0.90)) : Math.round(height * 0.42);
          const tapX = Math.round(width * 0.92);
          console.log(`  Tapping X icon at coordinates (${tapX}, ${tapY})...`);
          adbTap(tapX, tapY);
          await this.driver.pause(2000);

          const stillVisible = await headerEl.isDisplayed().catch(() => false);
          if (!stillVisible) {
            console.log('  ✓ "Update Your Payment Method" popup dismissed via coordinate tap.');
            return true;
          }
        } catch {}

        // 3. Fallback to "Remind Me Later"
        try {
          const remindLaterBtn = await this.driver.$('android=new UiSelector().textMatches("(?i)^Remind Me Later$")');
          if (await remindLaterBtn.isDisplayed().catch(() => false)) {
            console.log('  Clicking "Remind Me Later" button...');
            await remindLaterBtn.click();
            await this.driver.pause(2000);
            return true;
          }
        } catch {}
      }

      await this.driver.pause(1000);
    }

    console.log('  ℹ️ No "Update Your Payment Method" popup detected within timeout.');
    return false;
  }

  async navigateToMyAccount(): Promise<void> {
    console.log('Navigating to My Account...');

    const myAccountSelectors = [
      'android=new UiSelector().textContains("My Account")',
      'android=new UiSelector().textContains("Account")',
      'android=new UiSelector().textContains("Profile")',
      '//android.widget.TextView[contains(@text, "My Account")]',
      '//android.widget.TextView[contains(@text, "Account")]',
    ];

    for (const selector of myAccountSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed()) {
          console.log('  Found My Account, tapping...');
          await el.click();
          await this.driver.pause(3000);
          return;
        }
      } catch {}
    }

    const screenSize = getScreenSize();
    adbTap(Math.round(screenSize.width * 0.90), Math.round(screenSize.height * 0.06));
    await this.driver.pause(2000);

    const myAccountMenu = await this.findEl('android=new UiSelector().textContains("My Account")', 3000);
    if (myAccountMenu) {
      await myAccountMenu.click();
      await this.driver.pause(3000);
    }

    console.log('Navigated to My Account\n');
  }

  async openMyAccountPPVPaywall(hooks: AndroidFlowHooks = {}): Promise<boolean> {
    await this.navigateToMyAccount();
    await this.driver.pause(3000);

    console.log(`Looking for PPV: "${this.ppvName}" in My Account...`);
    let ppvAvailable = false;
    for (let i = 0; i < 10; i++) {
      if (await this.isVisible(this.ppvName, 2000)) {
        console.log(`Found PPV: "${this.ppvName}"`);
        ppvAvailable = true;
        break;
      }
      await this.scrollDown();
      await this.driver.pause(1000);
    }

    if (!ppvAvailable) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_myaccount_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'My Account');
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found in My Account`);
      throw new Error(`PPV "${this.ppvName}" not found in My Account. See test-results/android_myaccount_ppv_not_found.png`);
    }

    hooks.recordAvailability?.(true, undefined, 'My Account');

    const buyNowSelectors = [
      'android=new UiSelector().textContains("Buy now")',
      'android=new UiSelector().textContains("Buy Now")',
      'android=new UiSelector().textContains("Buy")',
      'android=new UiSelector().textContains("Purchase")',
    ];

    for (const selector of buyNowSelectors) {
      const buyBtn = await this.findEl(selector, 2000);
      if (buyBtn) {
        console.log('  Found Buy button, tapping...');
        await buyBtn.click();
        await this.driver.pause(3000);
        return true;
      }
    }

    await this.driver.saveScreenshot('./test-results/myaccount_buy_not_found.png');
    throw new Error(`Could not find Buy button for PPV: "${this.ppvName}" in My Account`);
  }

  async getPPVStatus(ppvName: string): Promise<string> {
    await this.navigateToMyAccount();
    await this.driver.pause(2000);

    // Scroll to find the PPV card
    for (let i = 0; i < 10; i++) {
      if (await this.isVisible(this.ppvDiscoveryTitleQuery(ppvName), 2000)) break;
      await this.scrollDown();
      await this.driver.pause(800);
    }

    // Check for Purchased / Included status first
    const statusSelectors = [
      'android=new UiSelector().textContains("Purchased")',
      'android=new UiSelector().textContains("Included")',
      'android=new UiSelector().textContains("Owned")',
    ];
    for (const selector of statusSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed()) {
          const text = await el.getText();
          if (text) return text.trim();
        }
      } catch {}
    }

    // Check for Buy button (not purchased)
    const buySelectors = [
      'android=new UiSelector().textContains("Buy now")',
      'android=new UiSelector().textContains("Buy Now")',
      'android=new UiSelector().textContains("Buy")',
      'android=new UiSelector().textContains("Purchase")',
    ];
    for (const selector of buySelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed()) {
          return 'Available';
        }
      } catch {}
    }

    return 'Unknown';
  }

  async hasPPVImage(ppvName: string): Promise<boolean> {
    await this.navigateToMyAccount();
    await this.driver.pause(2000);

    for (let i = 0; i < 10; i++) {
      if (await this.isVisible(this.ppvDiscoveryTitleQuery(ppvName), 2000)) break;
      await this.scrollDown();
      await this.driver.pause(800);
    }

    // Look for image near the PPV card (ImageView)
    const imageSelectors = [
      '//android.widget.ImageView',
      '//android.widget.ImageButton',
      '//*[contains(@class, "ImageView")]',
    ];
    for (const selector of imageSelectors) {
      try {
        const els = await this.driver.$(selector);
        if (await els.isDisplayed()) return true;
      } catch {}
    }
    return false;
  }

  async getPPVName(ppvName: string): Promise<string> {
    await this.navigateToMyAccount();
    await this.driver.pause(2000);

    for (let i = 0; i < 10; i++) {
      if (await this.isVisible(ppvName, 2000)) break;
      await this.scrollDown();
      await this.driver.pause(800);
    }

    try {
      const el = await this.driver.$(`android=new UiSelector().textContains("${this.ppvDiscoveryTitleQuery(ppvName)}")`);
      if (await el.isDisplayed()) {
        return (await el.getText())?.trim() || ppvName;
      }
    } catch {}

    // Fallback: look for any TextView near the top of the PPV card
    try {
      const cardText = await this.driver.$('//android.widget.TextView');
      if (await cardText.isDisplayed()) {
        return (await cardText.getText())?.trim() || ppvName;
      }
    } catch {}

    return ppvName;
  }

  async getPPVDate(ppvName: string): Promise<string> {
    await this.navigateToMyAccount();
    await this.driver.pause(2000);

    for (let i = 0; i < 10; i++) {
      if (await this.isVisible(this.ppvDiscoveryTitleQuery(ppvName), 2000)) break;
      await this.scrollDown();
      await this.driver.pause(800);
    }

    // Look for date patterns in any TextView (e.g. "Sat 12 Jul", "12 Jul 2026", "HH:MM")
    try {
      const textViews = await this.driver.$$('//android.widget.TextView');
      const allTexts: string[] = [];
      for (const tv of textViews) {
        try {
          const text = await tv.getText();
          if (text && text.trim()) allTexts.push(text.trim());
        } catch {}
      }

      // Match common date/time patterns
      const dateRe = /\b(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i;
      const timeRe = /(\d{1,2}:\d{2}(\s*[aApP][mM])?)/;
      const dateMatch = allTexts.find(t => dateRe.test(t));
      if (dateMatch) return dateMatch;

      const timeMatch = allTexts.find(t => timeRe.test(t));
      if (timeMatch) return timeMatch;
    } catch {}

    return 'N/A';
  }
}

export async function preLoginFlow(
  driver: WdBrowser,
  baseUrl: string,
  credentials: AndroidLoginCredentials,
): Promise<void> {
  return new AndroidMyAccountPage(driver).preLoginFlow(baseUrl, credentials);
}

export async function navigateToMyAccount(driver: WdBrowser): Promise<void> {
  return new AndroidMyAccountPage(driver).navigateToMyAccount();
}

export async function openMyAccountPPVPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidMyAccountPage(driver, ppvName).openMyAccountPPVPaywall(hooks);
}

export async function completeNativeSignup(
  driver: WdBrowser,
  credentials: { email: string; firstName: string; lastName: string; password: string },
): Promise<void> {
  const firstVisible = async (selectors: string[], timeoutMs: number): Promise<WdElement> => {
    let match: WdElement = null;
    await driver.waitUntil(async () => {
      for (const selector of selectors) {
        const candidate = await driver.$(selector).catch(() => null);
        if (candidate && await candidate.isDisplayed().catch(() => false)) {
          match = candidate;
          return true;
        }
      }
      return false;
    }, { timeout: timeoutMs, interval: 300, timeoutMsg: `Native signup control was not displayed: ${selectors[0]}` });
    return match;
  };
  const fill = async (selectors: string[], value: string, label: string) => {
    const field = await firstVisible(selectors, 15000);
    await field.click();
    await field.clearValue().catch(() => {});
    await field.setValue(value);
    console.log(`✅ Native signup ${label} entered.`);
  };
  const click = async (selectors: string[], label: string) => {
    const button = await firstVisible(selectors, 15000);
    await button.click();
    console.log(`✅ Native signup ${label} clicked.`);
  };

  await click([
    'android=new UiSelector().textMatches("(?i)^Log in$")',
    'android=new UiSelector().descriptionMatches("(?i)^Log in$")',
  ], 'Log in');
  await fill([
    'android=new UiSelector().resourceIdMatches("(?i).*(email|username).*")',
    'android=new UiSelector().className("android.widget.EditText")',
  ], credentials.email, 'email');
  await click([
    'android=new UiSelector().textMatches("(?i)^(Continue|Get started)$")',
    'android=new UiSelector().resourceIdMatches("(?i).*(continue|get_started).*")',
  ], 'Continue/Get started');
  await fill([
    'android=new UiSelector().resourceIdMatches("(?i).*(first.*name|given.*name).*")',
    'android=new UiSelector().descriptionContains("First name")',
  ], credentials.firstName, 'first name');
  await fill([
    'android=new UiSelector().resourceIdMatches("(?i).*(last.*name|family.*name).*")',
    'android=new UiSelector().descriptionContains("Last name")',
  ], credentials.lastName, 'last name');
  await fill([
    'android=new UiSelector().className("android.widget.EditText").password(true)',
    'android=new UiSelector().resourceIdMatches("(?i).*password.*")',
  ], credentials.password, 'password');
  await click([
    'android=new UiSelector().textMatches("(?i)^(Create account|Continue)$")',
    'android=new UiSelector().resourceIdMatches("(?i).*(create.*account|continue).*")',
  ], 'Create account/Continue');
  await click([
    'android=new UiSelector().textMatches("(?i)^Skip$")',
    'android=new UiSelector().descriptionMatches("(?i)^Skip$")',
  ], 'mandatory marketing Skip');
}
