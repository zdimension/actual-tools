export class TwoFactorRequiredError extends Error {
  reason: string;

  constructor(message: string = 'Two-factor authentication required') {
    super(message);
    this.name = 'TwoFactorRequiredError';
    this.reason = '2fa';
  }
}
