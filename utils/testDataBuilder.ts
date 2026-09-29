type TestUser = {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
};

/**
 * Creates a test user with randomized email to avoid conflicts
 * @returns TestUser object with email, firstName, lastName, and password
 */
export function createTestUser(prefix: string = 'dazn_test'): TestUser {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const runId = process.env.GITHUB_RUN_ID || 'local';
  const emailDomain = process.env.TEST_EMAIL_DOMAIN || 'yopmail.com';

  return {
    email: `${prefix}_${runId}_${timestamp}_${randomSuffix}@${emailDomain}`,
    firstName: 'Test',
    lastName: 'Automation',
    password: process.env.NEW_USER_PASSWORD || 'TestPassword123!',
  };
}

/**
 * Creates a test user with a specific email address
 * @param email - Custom email address
 * @returns TestUser object with specified email
 */
export function createTestUserWithEmail(email: string): TestUser {
  return {
    email,
    firstName: 'Test',
    lastName: 'Automation',
    password: process.env.NEW_USER_PASSWORD || 'TestPassword123!',
  };
}
