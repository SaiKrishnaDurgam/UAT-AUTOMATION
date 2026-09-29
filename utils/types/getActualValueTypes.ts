export interface PageType {
  ppv: string;
  daznPlan: string;
  payment: string;
  signup: string;
}

export interface FieldMapping {
  [key: string]: string;
}

export interface PageSelectors {
  [key: string]: string;
}

export interface SelectorsConfig {
  ppv: PageSelectors;
  daznPlan: PageSelectors;
  payment: PageSelectors;
  signup: PageSelectors;
}

export interface GetActualValueOptions {
  page: any;
  field: string;
  variant: string;
}

export interface ScopedLocators {
  ppvCard: any;
  upsellCard: any;
  trialCard: any;
}