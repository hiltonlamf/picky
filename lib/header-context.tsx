'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

type HeaderContextType = {
  restaurantName: string | null;
  setRestaurantName: (name: string | null) => void;
};

const HeaderContext = createContext<HeaderContextType>({
  restaurantName: null,
  setRestaurantName: () => {},
});

export function HeaderProvider({ children }: { children: ReactNode }) {
  const [restaurantName, setRestaurantName] = useState<string | null>(null);
  return (
    <HeaderContext.Provider value={{ restaurantName, setRestaurantName }}>
      {children}
    </HeaderContext.Provider>
  );
}

export function useHeader() {
  return useContext(HeaderContext);
}
