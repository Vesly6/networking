import {
  Handshake,
  Mail,
  Ban,
  Eye,
  UserPlus,
  Heart,
  Hourglass,
  Flag,
  Link,
  MessageCircle,
  Users,
  Radar,
  ThumbsUp,
  Settings,
  MailPlus,
  Star,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { LinkedInSequenceNodeType } from './linkedinCampaignsApi';

export type NodeCategory = 'action' | 'condition';

export interface NodeTypeMeta {
  type: LinkedInSequenceNodeType;
  category: NodeCategory;
  label: string;
  icon: LucideIcon;
  /** false = present in the palette but disabled ("netrukus" badge) — no
   * detection/execution implemented yet server-side. See
   * server/src/linkedin/scheduler.ts's evaluateCondition() and
   * executeAction() for the backend half of this same split. */
  enabled: boolean;
  /** Why it's disabled — shown as the palette button's title tooltip.
   * Only set for disabled types. */
  disabledReason?: string;
}

// One shared source of truth for every place a node type needs a label/
// icon/enabled-state (the graph editor's palette, the analytics step
// breakdown table) — duplicating this per-component risks the two
// silently drifting (a new type added to one list but not the other).
export const NODE_TYPE_META: Record<LinkedInSequenceNodeType, NodeTypeMeta> = {
  connect: { type: 'connect', category: 'action', label: 'Connection request', icon: Handshake, enabled: true },
  message: { type: 'message', category: 'action', label: 'Žinutė', icon: Mail, enabled: true },
  withdraw: { type: 'withdraw', category: 'action', label: 'Atšaukti kvietimą', icon: Ban, enabled: true },
  view_profile: { type: 'view_profile', category: 'action', label: 'Peržiūrėti profilį', icon: Eye, enabled: true },
  follow: { type: 'follow', category: 'action', label: 'Sekti', icon: UserPlus, enabled: true },
  like_post: { type: 'like_post', category: 'action', label: 'Patinka paskutiniam įrašui', icon: Heart, enabled: true },
  wait: { type: 'wait', category: 'action', label: 'Palaukti', icon: Hourglass, enabled: true },
  end: { type: 'end', category: 'action', label: 'Pabaiga', icon: Flag, enabled: true },
  condition_connected: { type: 'condition_connected', category: 'condition', label: 'Ar priėmė kvietimą?', icon: Link, enabled: true },
  condition_replied: { type: 'condition_replied', category: 'condition', label: 'Ar atsakė?', icon: MessageCircle, enabled: true },
  condition_followed_back: {
    type: 'condition_followed_back',
    category: 'condition',
    label: 'Ar seka mane?',
    icon: Users,
    enabled: false,
    disabledReason: 'Dar neįgyvendinta — reikia naujo LinkedIn stebėjimo mechanizmo.',
  },
  condition_profile_visited: {
    type: 'condition_profile_visited',
    category: 'condition',
    label: 'Ar aplankė profilį?',
    icon: Radar,
    enabled: false,
    disabledReason: 'Dar neįgyvendinta — reikia naujo LinkedIn stebėjimo mechanizmo.',
  },
  condition_post_liked: {
    type: 'condition_post_liked',
    category: 'condition',
    label: 'Ar patiko įrašas?',
    icon: ThumbsUp,
    enabled: false,
    disabledReason: 'Dar neįgyvendinta — reikia naujo LinkedIn stebėjimo mechanizmo.',
  },
  condition_custom: {
    type: 'condition_custom',
    category: 'condition',
    label: 'Pasirinktina sąlyga',
    icon: Settings,
    enabled: false,
    disabledReason: 'Dar neįgyvendinta.',
  },
  inmail: { type: 'inmail', category: 'action', label: 'InMail', icon: MailPlus, enabled: false, disabledReason: 'Reikia patvirtintos Sales Navigator/Recruiter paskyros.' },
  endorse: { type: 'endorse', category: 'action', label: 'Patvirtinti įgūdį', icon: Star, enabled: false, disabledReason: 'Dar neįgyvendinta.' },
  find_email: { type: 'find_email', category: 'action', label: 'Rasti el. paštą', icon: Search, enabled: false, disabledReason: 'Dar neįgyvendinta.' },
};

/** For JSX call sites that need the icon rendered (the graph editor's
 * nodes/palette, the analytics step-breakdown table) — a component
 * reference can't be embedded in a plain string the way the old emoji
 * character could, so this is now separate from the plain-text label
 * (nodeTypeLabel/`meta.label`) rather than one combined string. */
export function nodeTypeIcon(type: LinkedInSequenceNodeType): LucideIcon | null {
  return NODE_TYPE_META[type]?.icon ?? null;
}

/** Plain text only, no icon — for contexts that render a string, not JSX
 * (e.g. a confirm-dialog message). Use nodeTypeIcon() + meta.label
 * together for anywhere that can render real elements. */
export function nodeTypeLabel(type: LinkedInSequenceNodeType): string {
  return NODE_TYPE_META[type]?.label ?? type;
}

export const ACTION_NODE_TYPES = Object.values(NODE_TYPE_META).filter((m) => m.category === 'action');
export const CONDITION_NODE_TYPES = Object.values(NODE_TYPE_META).filter((m) => m.category === 'condition');

export function isConditionType(type: LinkedInSequenceNodeType): boolean {
  return NODE_TYPE_META[type]?.category === 'condition';
}
