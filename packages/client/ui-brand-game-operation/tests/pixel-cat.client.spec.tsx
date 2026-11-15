// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAT_ARTWORK } from '../src/client/home-cat/artwork.ts'
import { PixelCat } from '../src/client/home-cat/PixelCat.tsx'
import { attachPixelCat } from '../src/client/home-cat/renderer.ts'

vi.mock('../src/client/home-cat/renderer.ts', () => ({ attachPixelCat: vi.fn() }))

const attach = vi.mocked(attachPixelCat)

function handle() {
  const cat = { play: vi.fn(), dispose: vi.fn() }
  attach.mockReturnValueOnce(cat)
  return cat
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  document.body.replaceChildren()
  attach.mockReset()
})

describe('pixel cat frame layer', () => {
  it('attaches the artwork to a canvas before its content and releases it on unmount', () => {
    const cat = handle()
    const view = render(<PixelCat hero><p>content</p></PixelCat>)
    const canvas = view.container.querySelector('canvas')
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    expect(canvas?.nextElementSibling?.textContent).toBe('content')
    expect(attach).toHaveBeenCalledExactlyOnceWith(canvas, CAT_ARTWORK, expect.stringContaining('cat-atlas'))
    view.rerender(<PixelCat hero><p>updated</p></PixelCat>)
    expect(attach).toHaveBeenCalledOnce()
    view.unmount()
    expect(cat.dispose).toHaveBeenCalledOnce()
  })

  it('wraps its content without decoration outside the blank home', () => {
    const cat = handle()
    const view = render(<PixelCat hero><p>content</p></PixelCat>)
    view.rerender(<PixelCat hero={false}><p>content</p></PixelCat>)
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(view.getByText('content')).toBeTruthy()
    expect(cat.dispose).toHaveBeenCalledOnce()
    fireEvent.click(view.getByText('content'))
    expect(cat.play).not.toHaveBeenCalled()
  })

  it('plays only for primary clicks on blank space inside its own frame', () => {
    const cat = handle()
    const overlay = document.createElement('div')
    document.body.append(overlay)
    const view = render(
      <PixelCat hero>
        <section data-testid="blank">
          <button type="button">control</button>
          <div data-composer-card=""><span>card</span></div>
          {createPortal(<span>overlay</span>, overlay)}
        </section>
      </PixelCat>,
    )
    fireEvent.click(view.getByText('control'))
    fireEvent.click(view.getByText('card'))
    fireEvent.click(view.getByText('overlay'))
    fireEvent.click(view.getByTestId('blank'), { button: 2 })
    expect(cat.play).not.toHaveBeenCalled()
    fireEvent.click(view.getByTestId('blank'))
    expect(cat.play).toHaveBeenCalledOnce()
  })

  it('does not play when the click ends a text selection made inside its frame', () => {
    const cat = handle()
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.append(outside)
    const view = render(<PixelCat hero><p data-testid="text">selectable headline</p></PixelCat>)
    const text = view.getByTestId('text')
    const selection = window.getSelection()!
    selection.selectAllChildren(text)
    fireEvent.click(text)
    expect(cat.play).not.toHaveBeenCalled()
    // A selection left elsewhere in the document does not block playback.
    selection.selectAllChildren(outside)
    fireEvent.click(text)
    expect(cat.play).toHaveBeenCalledOnce()
    selection.removeAllRanges()
    fireEvent.click(text)
    expect(cat.play).toHaveBeenCalledTimes(2)
  })

  it('plays when the document exposes no selection', () => {
    const cat = handle()
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    const view = render(<PixelCat hero><p data-testid="text">headline</p></PixelCat>)
    fireEvent.click(view.getByTestId('text'))
    expect(cat.play).toHaveBeenCalledOnce()
  })
})
