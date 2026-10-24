"""Select one complete native lettering line without editing its glyphs.

OCR geometry determines rows and whole alpha components before the requested
text is considered. Ambiguous or connected rows are rejected, never cut apart.
"""
import hashlib
import math
import unicodedata

import numpy as np
from PIL import Image

MAX_OCR_BLOCKS=16
MAX_COMPONENTS=4096
MAX_RUNS=131072
MAX_PIXELS=8*1024*1024
SCHEMA='aiworker-lettering-line-selection/v1'


def _sha(data):return hashlib.sha256(data).hexdigest()


def _box(rect):
    x0,y0,x1,y1=rect
    return {'x':x0,'y':y0,'width':x1-x0,'height':y1-y0}


def _group_lines(observed,size):
    if not isinstance(observed,dict)or not isinstance(observed.get('lines'),list):
        raise ValueError('protected_text_line_ocr_invalid')
    blocks=observed['lines']
    if not 1<=len(blocks)<=MAX_OCR_BLOCKS:raise ValueError('protected_text_line_selection_budget')
    if any(k in observed and observed[k]!=size[i]for i,k in enumerate(('width','height'))):
        raise ValueError('protected_text_line_ocr_dimensions_invalid')
    checked=[]
    for index,block in enumerate(blocks):
        if not isinstance(block,dict):raise ValueError('protected_text_line_ocr_invalid')
        text=block.get('text');box=block.get('box');confidence=block.get('confidence')
        if (not isinstance(text,str)or not 0<len(text)<=512 or not isinstance(box,list)or len(box)!=4
                or any(type(v)is not int for v in box)
                or type(confidence)not in (int,float)or not math.isfinite(confidence)or not 0<=confidence<=1):
            raise ValueError('protected_text_line_ocr_invalid')
        x,y,w,h=box
        if min(x,y)<0 or min(w,h)<1 or x+w>size[0]or y+h>size[1]:
            raise ValueError('protected_text_line_ocr_invalid')
        checked.append({'index':index,'text':text,'rect':(x,y,x+w,y+h),'confidence':confidence})
    parent=list(range(len(checked)))
    def root(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    for i,a in enumerate(checked):
        ax,ay,ar,ab=a['rect'];ah=ab-ay
        for j,b in enumerate(checked[:i]):
            bx,by,br,bb=b['rect'];bh=bb-by
            overlap=max(0,min(ab,bb)-max(ay,by))
            horizontal=max(0,min(ar,br)-max(ax,bx))
            # Same-baseline OCR blocks may be separate words or quote marks.
            # Horizontally superposed blocks are not silently merged aliases.
            if (overlap>=.55*min(ah,bh)and abs((ay+ab)-(by+bb))<=.9*max(ah,bh)
                    and horizontal<=.25*min(ar-ax,br-bx)):
                parent[root(i)]=root(j)
    groups={}
    for i,block in enumerate(checked):groups.setdefault(root(i),[]).append(block)
    result=[]
    for members in groups.values():
        members.sort(key=lambda b:(b['rect'][0],b['index']))
        rect=(min(b['rect'][0]for b in members),min(b['rect'][1]for b in members),
              max(b['rect'][2]for b in members),max(b['rect'][3]for b in members))
        if len(members)>1 and rect[3]-rect[1]>1.35*max(b['rect'][3]-b['rect'][1]for b in members):
            raise ValueError('protected_text_ocr_row_geometry_ambiguous')
        result.append({'text':''.join(b['text']for b in members),'rect':rect,
            'confidence':min(b['confidence']for b in members),
            'ocrBlockIndices':[b['index']for b in members]})
    result.sort(key=lambda line:((line['rect'][1]+line['rect'][3])/2,line['rect'][0]))
    return result


def _components(mask):
    """Eight-connected components via bounded horizontal runs, not pixel BFS."""
    runs=[];parent=[];previous=[]
    def root(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    def join(i,j):
        i,j=root(i),root(j)
        if i!=j:parent[max(i,j)]=min(i,j)
    for y,row in enumerate(mask):
        bounds=np.flatnonzero(np.diff(np.r_[False,row,False]))
        current=[];cursor=0
        for left,right in zip(bounds[::2],bounds[1::2]):
            x0,x1=int(left),int(right);index=len(runs)
            if index>=MAX_RUNS:raise ValueError('protected_text_line_selection_budget')
            runs.append((x0,x1,y));parent.append(index);current.append((x0,x1,index))
            while cursor<len(previous)and previous[cursor][1]<x0:cursor+=1
            k=cursor
            while k<len(previous)and previous[k][0]<=x1:
                join(index,previous[k][2]);k+=1
        previous=current
    found={}
    for i,(x0,x1,y)in enumerate(runs):
        component=found.setdefault(root(i),{'runs':[],'rect':(x0,y,x1,y+1),'pixels':0})
        component['runs'].append((x0,x1,y));component['pixels']+=x1-x0
        a,b,c,d=component['rect'];component['rect']=(min(a,x0),min(b,y),max(c,x1),max(d,y+1))
    if not 1<=len(found)<=MAX_COMPONENTS:raise ValueError('protected_text_line_selection_budget')
    return sorted(found.values(),key=lambda c:(c['rect'][1],c['rect'][0],c['rect'][3],c['rect'][2]))


def _inside(component,rect):
    left,top,right,bottom=rect
    return sum(max(0,min(x1,right)-max(x0,left))for x0,x1,y in component['runs']if top<=y<bottom)


def select_lettering_line(rgba,observed,expected_text):
    """Return an unmodified native component subset and reproducible proof.

    The caller must still verify OCR of this selected image and the actual
    composited ROI, and may only fit it without enlarging native glyph pixels.
    """
    if (not isinstance(rgba,Image.Image)or rgba.mode!='RGBA'or min(rgba.size)<1
            or rgba.width*rgba.height>MAX_PIXELS or max(rgba.size)>4096):
        raise ValueError('protected_text_line_asset_invalid')
    if (not isinstance(expected_text,str)or not 0<len(expected_text)<=128 or expected_text!=expected_text.strip()
            or any(unicodedata.category(c).startswith('C')for c in expected_text)):
        raise ValueError('protected_text_line_expected_invalid')
    pixels=np.asarray(rgba);mask=pixels[:,:,3]>0
    lines=_group_lines(observed,rgba.size)
    components=_components(mask)
    for component in components:
        x0,y0,x1,y1=component['rect']
        if x0==0 or y0==0 or x1==rgba.width or y1==rgba.height:
            raise ValueError('protected_text_line_asset_clipped')
        exact=[];padded=[]
        for line in lines:
            a,b,c,d=line['rect'];margin=max(2,math.ceil((d-b)*.12))
            exact.append(_inside(component,(a,b,c,d))/component['pixels'])
            padded.append(_inside(component,(a-margin,b-margin,c+margin,d+margin))/component['pixels'])
        owner=max(range(len(lines)),key=lambda i:(exact[i],padded[i]))
        others=[exact[i]for i in range(len(lines))if i!=owner]
        if any(score>.1 for score in others):
            raise ValueError('protected_text_component_crosses_lines')
        owner_rect=lines[owner]['rect']
        for index,line in enumerate(lines):
            if index==owner:continue
            a,b,c,d=line['rect'];e,f,g,h=owner_rect
            overlap=(max(a,e),max(b,f),min(c,g),min(d,h))
            shared=_inside(component,overlap)if overlap[0]<overlap[2]and overlap[1]<overlap[3]else 0
            # Even a tiny connecting stroke in another row's exclusive area
            # cannot be assigned away just because the first row is larger.
            if _inside(component,line['rect'])>shared:
                raise ValueError('protected_text_component_crosses_lines')
        if padded[owner]<.98:
            raise ValueError('protected_text_component_unassigned')
        if exact[owner]<.5 and sum(score>=.98 for score in padded)!=1:
            raise ValueError('protected_text_component_ambiguous')
        component['lineIndex']=owner
    line_masks=[np.zeros(mask.shape,dtype=bool)for _ in lines]
    for component in components:
        for x0,x1,y in component['runs']:line_masks[component['lineIndex']][y,x0:x1]=True
    if any(not member.any()for member in line_masks):
        raise ValueError('protected_text_ocr_line_without_ink')
    if not np.array_equal(np.logical_or.reduce(line_masks),mask):
        raise ValueError('protected_text_component_accounting_invalid')
    # Only here does expected text affect selection. It never controls a crop,
    # glyph segmentation, character repair, or deletion of quote components.
    from .protected_cover import normalized_text
    matching=[i for i,line in enumerate(lines)if normalized_text(line['text'])==normalized_text(expected_text)]
    if not matching:raise ValueError('protected_text_line_selection_missing')
    selected=matching[0]
    if lines[selected]['confidence']<.8:raise ValueError('protected_text_line_ocr_uncertain')
    selected_ids=[i for i,c in enumerate(components)if c['lineIndex']==selected]
    boxes=[components[i]['rect']for i in selected_ids]
    rect=(min(b[0]for b in boxes),min(b[1]for b in boxes),max(b[2]for b in boxes),max(b[3]for b in boxes))
    x0,y0,x1,y1=rect
    if x1-x0<32 or y1-y0<12:raise ValueError('protected_text_native_resolution_too_low')
    selected_mask=line_masks[selected]
    crop=pixels[y0:y1,x0:x1].copy()
    crop[:,:,3]=np.where(selected_mask[y0:y1,x0:x1],crop[:,:,3],0)
    result=Image.fromarray(crop,'RGBA')
    summary=[]
    for index,line in enumerate(lines):
        ids=[i for i,c in enumerate(components)if c['lineIndex']==index]
        summary.append({'lineIndex':index,'observedText':line['text'],'confidence':line['confidence'],
            'ocrBox':_box(line['rect']),'ocrBlockIndices':line['ocrBlockIndices'],
            'componentIds':ids,'pixels':int(line_masks[index].sum()),
            'maskSha256':_sha(line_masks[index].tobytes())})
    proof={'schema':SCHEMA,'strategy':'first_complete_matching_native_line',
        'selectedLineIndex':selected,'selectedRect':_box(rect),
        'sourceWidth':rgba.width,'sourceHeight':rgba.height,'sourceRgbaSha256':_sha(pixels.tobytes()),
        'nativeInkMaskSha256':_sha(mask.tobytes()),'selectedMaskSha256':_sha(selected_mask.tobytes()),
        'componentCount':len(components),'selectedComponentCount':len(selected_ids),
        'selectedComponentIds':selected_ids,'selectedRgbaSha256':_sha(crop.tobytes()),
        'components':[{'id':i,'box':_box(c['rect']),'pixels':c['pixels'],'lineIndex':c['lineIndex']}
                      for i,c in enumerate(components)],
        'selectedLine':summary[selected],
        'discardedLines':[line for line in summary if line['lineIndex']!=selected]}
    return result,proof
