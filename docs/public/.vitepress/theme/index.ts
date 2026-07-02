import { h } from 'vue'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import TerminalDemo from './TerminalDemo.vue'
import './custom.css'

// Custom theme: the default theme plus an animated terminal demo rendered
// between the hero and the feature grid on the landing page.
const theme: Theme = {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-after': () => h(TerminalDemo),
    })
  },
}

export default theme
