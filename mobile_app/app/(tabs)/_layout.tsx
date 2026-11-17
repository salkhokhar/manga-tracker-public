import { Tabs, usePathname, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { useAppTheme } from '../../services/theme';

export default function TabsLayout() {
  const { colors } = useAppTheme();
  const pathname = usePathname();
  const params = useLocalSearchParams();

  useEffect(() => {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] [NAVIGATE]: ${pathname}`, JSON.stringify(params));
  }, [pathname, params]);

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          tabBarIcon: ({ color }) => <Ionicons name="library" size={24} color={typeof color === 'string' ? color : undefined} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <Ionicons name="search" size={24} color={typeof color === 'string' ? color : undefined} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <Ionicons name="person-circle-outline" size={26} color={typeof color === 'string' ? color : undefined} />,
        }}
      />
    </Tabs>
  );
}
