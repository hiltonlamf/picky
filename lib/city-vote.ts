export type CityVoteRegion = 'Europe' | 'Asia' | 'USA' | 'Australia';

export interface CityVoteOption {
  city: string;
  country: string;
  region: CityVoteRegion;
  flag: string;
}

export const CITY_VOTE_OPTIONS: readonly CityVoteOption[] = [
  { city: 'Amsterdam', country: 'Netherlands', region: 'Europe', flag: '🇳🇱' },
  { city: 'Athens', country: 'Greece', region: 'Europe', flag: '🇬🇷' },
  { city: 'Barcelona', country: 'Spain', region: 'Europe', flag: '🇪🇸' },
  { city: 'Berlin', country: 'Germany', region: 'Europe', flag: '🇩🇪' },
  { city: 'Brussels', country: 'Belgium', region: 'Europe', flag: '🇧🇪' },
  { city: 'Budapest', country: 'Hungary', region: 'Europe', flag: '🇭🇺' },
  { city: 'Copenhagen', country: 'Denmark', region: 'Europe', flag: '🇩🇰' },
  { city: 'Edinburgh', country: 'United Kingdom', region: 'Europe', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  { city: 'Florence', country: 'Italy', region: 'Europe', flag: '🇮🇹' },
  { city: 'Frankfurt', country: 'Germany', region: 'Europe', flag: '🇩🇪' },
  { city: 'Geneva', country: 'Switzerland', region: 'Europe', flag: '🇨🇭' },
  { city: 'Glasgow', country: 'United Kingdom', region: 'Europe', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  { city: 'Helsinki', country: 'Finland', region: 'Europe', flag: '🇫🇮' },
  { city: 'Istanbul', country: 'Türkiye', region: 'Europe', flag: '🇹🇷' },
  { city: 'Lisbon', country: 'Portugal', region: 'Europe', flag: '🇵🇹' },
  { city: 'London', country: 'United Kingdom', region: 'Europe', flag: '🇬🇧' },
  { city: 'Lyon', country: 'France', region: 'Europe', flag: '🇫🇷' },
  { city: 'Madrid', country: 'Spain', region: 'Europe', flag: '🇪🇸' },
  { city: 'Manchester', country: 'United Kingdom', region: 'Europe', flag: '🇬🇧' },
  { city: 'Milan', country: 'Italy', region: 'Europe', flag: '🇮🇹' },
  { city: 'Munich', country: 'Germany', region: 'Europe', flag: '🇩🇪' },
  { city: 'Naples', country: 'Italy', region: 'Europe', flag: '🇮🇹' },
  { city: 'Oslo', country: 'Norway', region: 'Europe', flag: '🇳🇴' },
  { city: 'Paris', country: 'France', region: 'Europe', flag: '🇫🇷' },
  { city: 'Porto', country: 'Portugal', region: 'Europe', flag: '🇵🇹' },
  { city: 'Prague', country: 'Czechia', region: 'Europe', flag: '🇨🇿' },
  { city: 'Rome', country: 'Italy', region: 'Europe', flag: '🇮🇹' },
  { city: 'Stockholm', country: 'Sweden', region: 'Europe', flag: '🇸🇪' },
  { city: 'Vienna', country: 'Austria', region: 'Europe', flag: '🇦🇹' },
  { city: 'Warsaw', country: 'Poland', region: 'Europe', flag: '🇵🇱' },
  { city: 'Zurich', country: 'Switzerland', region: 'Europe', flag: '🇨🇭' },

  { city: 'Bali', country: 'Indonesia', region: 'Asia', flag: '🇮🇩' },
  { city: 'Bangkok', country: 'Thailand', region: 'Asia', flag: '🇹🇭' },
  { city: 'Beijing', country: 'China', region: 'Asia', flag: '🇨🇳' },
  { city: 'Bengaluru', country: 'India', region: 'Asia', flag: '🇮🇳' },
  { city: 'Busan', country: 'South Korea', region: 'Asia', flag: '🇰🇷' },
  { city: 'Chiang Mai', country: 'Thailand', region: 'Asia', flag: '🇹🇭' },
  { city: 'Delhi', country: 'India', region: 'Asia', flag: '🇮🇳' },
  { city: 'Dubai', country: 'United Arab Emirates', region: 'Asia', flag: '🇦🇪' },
  { city: 'Hanoi', country: 'Vietnam', region: 'Asia', flag: '🇻🇳' },
  { city: 'Ho Chi Minh City', country: 'Vietnam', region: 'Asia', flag: '🇻🇳' },
  { city: 'Hong Kong', country: 'Hong Kong', region: 'Asia', flag: '🇭🇰' },
  { city: 'Jakarta', country: 'Indonesia', region: 'Asia', flag: '🇮🇩' },
  { city: 'Kuala Lumpur', country: 'Malaysia', region: 'Asia', flag: '🇲🇾' },
  { city: 'Kyoto', country: 'Japan', region: 'Asia', flag: '🇯🇵' },
  { city: 'Manila', country: 'Philippines', region: 'Asia', flag: '🇵🇭' },
  { city: 'Mumbai', country: 'India', region: 'Asia', flag: '🇮🇳' },
  { city: 'Osaka', country: 'Japan', region: 'Asia', flag: '🇯🇵' },
  { city: 'Seoul', country: 'South Korea', region: 'Asia', flag: '🇰🇷' },
  { city: 'Shanghai', country: 'China', region: 'Asia', flag: '🇨🇳' },
  { city: 'Singapore', country: 'Singapore', region: 'Asia', flag: '🇸🇬' },
  { city: 'Taipei', country: 'Taiwan', region: 'Asia', flag: '🇹🇼' },
  { city: 'Tokyo', country: 'Japan', region: 'Asia', flag: '🇯🇵' },

  { city: 'Atlanta', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Austin', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Boston', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Chicago', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Dallas', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Denver', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Houston', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Las Vegas', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Los Angeles', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Miami', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Minneapolis', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Nashville', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'New Orleans', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'New York City', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Philadelphia', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Phoenix', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Portland', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'San Diego', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'San Francisco', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Seattle', country: 'United States', region: 'USA', flag: '🇺🇸' },
  { city: 'Washington, DC', country: 'United States', region: 'USA', flag: '🇺🇸' },

  { city: 'Adelaide', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Brisbane', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Canberra', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Darwin', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Gold Coast', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Hobart', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Melbourne', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Perth', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
  { city: 'Sydney', country: 'Australia', region: 'Australia', flag: '🇦🇺' },
] as const;

export function normaliseCustomCity(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function cityVoteKey(city: string, country: string): string {
  return `${city}, ${country}`.toLocaleLowerCase('en');
}
