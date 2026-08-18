/** A curated list of common job titles across departments/seniority levels
 * — used to give the Job Titles filter a pick-from list instead of pure
 * free typing, per explicit request ("job titles тоже здесь были бы все
 * варианты"). Apollo's public API has no typeahead/suggestion endpoint for
 * titles (confirmed against their docs), so this is a static, curated set
 * rather than anything account- or API-derived — the filter still accepts
 * any custom typed value too, this list is a starting point, not a cap. */
export const JOB_TITLES = [
  // Executive
  'CEO', 'Chief Executive Officer', 'COO', 'Chief Operating Officer', 'CFO', 'Chief Financial Officer',
  'CTO', 'Chief Technology Officer', 'CMO', 'Chief Marketing Officer', 'CRO', 'Chief Revenue Officer',
  'CIO', 'Chief Information Officer', 'CHRO', 'Chief Human Resources Officer', 'CPO', 'Chief Product Officer',
  'Chief of Staff', 'President', 'Vice President', 'VP of Sales', 'VP of Marketing', 'VP of Engineering',
  'VP of Operations', 'VP of Product', 'VP of Finance', 'VP of Customer Success', 'VP of Human Resources',
  'Founder', 'Co-Founder', 'Owner', 'Managing Director', 'General Manager', 'Partner',

  // Sales
  'Head of Sales', 'Sales Director', 'Sales Manager', 'Sales Representative', 'Account Executive',
  'Account Manager', 'Business Development Manager', 'Business Development Representative',
  'Sales Development Representative', 'Regional Sales Manager', 'Inside Sales Representative',
  'Enterprise Account Executive', 'Sales Operations Manager', 'Channel Sales Manager', 'Key Account Manager',

  // Marketing
  'Head of Marketing', 'Marketing Director', 'Marketing Manager', 'Digital Marketing Manager',
  'Product Marketing Manager', 'Content Marketing Manager', 'Growth Marketing Manager', 'Brand Manager',
  'Marketing Coordinator', 'Marketing Specialist', 'SEO Specialist', 'Social Media Manager',
  'Demand Generation Manager', 'Communications Manager', 'PR Manager',

  // Engineering / Product / IT
  'Head of Engineering', 'Engineering Manager', 'Software Engineer', 'Senior Software Engineer',
  'Staff Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Full Stack Engineer',
  'DevOps Engineer', 'Site Reliability Engineer', 'QA Engineer', 'Data Engineer', 'Data Scientist',
  'Machine Learning Engineer', 'Solutions Architect', 'Product Manager', 'Senior Product Manager',
  'Head of Product', 'Product Owner', 'UX Designer', 'UI Designer', 'Product Designer',
  'IT Manager', 'IT Director', 'Systems Administrator', 'Network Engineer', 'Security Engineer',

  // Operations / Finance
  'Operations Manager', 'Operations Director', 'Head of Operations', 'Project Manager', 'Program Manager',
  'Supply Chain Manager', 'Logistics Manager', 'Procurement Manager', 'Finance Manager', 'Finance Director',
  'Controller', 'Financial Analyst', 'Accountant', 'Accounting Manager', 'Treasurer',

  // HR / People
  'Head of HR', 'HR Director', 'HR Manager', 'HR Business Partner', 'Talent Acquisition Manager',
  'Recruiter', 'People Operations Manager', 'Training Manager', 'Compensation and Benefits Manager',

  // Customer Success / Support
  'Head of Customer Success', 'Customer Success Manager', 'Customer Success Director',
  'Customer Support Manager', 'Support Specialist', 'Technical Support Engineer', 'Implementation Manager',
  'Onboarding Specialist',

  // Other / General
  'Consultant', 'Senior Consultant', 'Analyst', 'Senior Analyst', 'Executive Assistant',
  'Administrative Assistant', 'Office Manager', 'Legal Counsel', 'General Counsel',
  'Director', 'Senior Director', 'Manager', 'Senior Manager', 'Coordinator', 'Specialist', 'Associate',
];
