/** Apollo's own "# Employees" preset buckets — the same 11-bucket list
 * their product itself offers as clickable chips (well-corroborated across
 * their search-filter documentation and reference material, not invented
 * here), passed through as-is to organization_num_employees_ranges (each
 * a "min,max" string). "10001+" has no real upper bound in Apollo's data,
 * so it's approximated with a very large max — the same open-ended-bucket
 * approach any filter with a "+" tier needs. */
export const EMPLOYEE_RANGES: Array<{ label: string; value: string }> = [
  { label: '1-10', value: '1,10' },
  { label: '11-20', value: '11,20' },
  { label: '21-50', value: '21,50' },
  { label: '51-100', value: '51,100' },
  { label: '101-200', value: '101,200' },
  { label: '201-500', value: '201,500' },
  { label: '501-1,000', value: '501,1000' },
  { label: '1,001-2,000', value: '1001,2000' },
  { label: '2,001-5,000', value: '2001,5000' },
  { label: '5,001-10,000', value: '5001,10000' },
  { label: '10,001+', value: '10001,100000000' },
];
